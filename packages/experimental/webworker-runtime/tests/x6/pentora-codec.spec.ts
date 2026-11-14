/**
 * Pentora carries her weight CPU's weights. The pinned cell `pentora-codec` encodes
 * her 1,329 real Kyber CPU weights onto the 110 exact PENTORA directions and recovers every one of them with the packets
 * of nodes 0..9 dropped (`drop-0-9`) or with all 30 face-centre packets dropped (`menger-80`, keeping the 80 Menger
 * skeleton nodes at squared radius 2 or 3); and `x6_cell { action: "carry" }` does it in one call.
 *
 * What is held here, and against what:
 *   - the tables in the shipped WAT are A regenerated from the pinned geometry (sha256 96b27c9b...8c61, the same pin as
 *     the Aura figure's tables.ts), the 30 face-centres / 80 Menger nodes match the pinned geometry's squared radii, and
 *     L A_kept = D I (with L strictly zero on every dropped node) is re-proved with BigInt for all three keep-sets, here,
 *     not by the build;
 *   - the build's check mode: the tables and the metered bytes are identical to a rebuild through the pinned skillsmith;
 *   - the own packets (her evidence pentora110-qphi72.json, sha256 2298a5aa...6935, copied as a fixture) equal the
 *     cell's encoding of her weights value for value: an independent construction of the same A;
 *   - every refusal is closed and carries no values, including a cell built with one wrong table entry.
 * The cell is called in-process exactly as her execution worker calls it (fresh instance, fuel grant, mv_alloc, mv_run),
 * and through the real host and her mounted runtime for the pin, `info` and `carry`.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility } from '../../src/x6/ball-loader.ts'
import {
  CARRY_CARRIER_NOTE,
  CARRY_RECORD_ID,
  carryCarrierDisclosure,
  carryRecordId,
  carryScalars,
  FACE_30_NODES,
  MENGER_80_NODES,
} from '../../src/x6/pentora-carry.ts'
import { skillId } from '../../src/x6/skill-record.ts'
import * as wasmCells from '../../src/x6/wasm-cells.ts'
import { CELL_BROWSER_FUEL_CAP, CELL_MAX_MEMORY_PAGES, CELL_PINS, METERED_CELL_EXPORTS, admitCell, cellCanonicalJson,
  createCellHost, inspectWasmMemory, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { FakeSocket, mountE4 } from './e4-fixture.ts'

const REPO = new URL('../../../../../', import.meta.url)
const CELLS = new URL('apps/web/public/cells/', REPO)
const ORIGIN = 'https://pentcodec-fixture.invalid'
const PIN = CELL_PINS['pentora-codec']!
const GEOMETRY_SHA256 = '96b27c9b4de41cd961612be5b1e88d40e973a2fded16bd320415b3e15e3b8c61'
/** The packets file (kybercpu evidence pentora/fullgraph/pentora110-qphi72.json, SHA256SUMS). */
const DOT_PACKETS_SHA256 = '2298a5aa3b9f6e3fa90d9fde5197822af1c9606c6c017a551dc4b70115126935'
/** The decoded stream: sha256 of the 1,329 scalars as int16 LE (cpu/fullgraph-decode.json). */
const DOT_INT16_SHA256 = 'f3cd0f6f6e8fbc6ac1f4b370eec4f6551bf1bfb14c79630ec730ad6cf41a3393'
const DOT_WEIGHTS_SHA256 = '6856c5fcdb0d50ebb8b1e402afa85385e307c58d1922a3bf7f73462539acf61c'
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

type J = Record<string, unknown>
interface Keep { keptNodes: number[]; D: bigint; even: { rows: number[]; L: bigint[][] }; odd: { rows: number[]; L: bigint[][] } }
interface Build {
  GEOMETRY_SHA256: string
  FACE_30_NODES: readonly number[]
  MENGER_80_NODES: readonly number[]
  KEEP_SETS: Readonly<Record<string, readonly number[]>>
  EVEN_SLOTS: readonly number[]
  ODD_SLOTS: readonly number[]
  geometryBytes(): Uint8Array
  evaluationMatrix(): { A: bigint[][]; radii: number[] }
  generateTables(): { text: string; facts: { packetMax: bigint; keep: Record<string, { kept: number; dBits: number; lBits: number }> } }
  watWithTables(wat: string, tables: string): string
  tablesFromWat(wat: string): { A: bigint[][]; keeps: Record<string, Keep>; cols: number[]; mengerNodes: number[]; packetMax: bigint }
  buildPentoraCodecCell(wat?: string): { metered: Uint8Array<ArrayBuffer> }
}
const build = async (): Promise<Build> => {
  const loaded: unknown = await import(new URL('server/pentora-codec.build.mjs', REPO).href)
  return loaded as Build
}

interface Exports {
  memory: WebAssembly.Memory
  mv_alloc(length: number): number
  mv_run(pointer: number, length: number): bigint
  __mv_fuel_set(fuel: bigint): void
  __mv_fuel_remaining(): bigint
}
interface Called { answer: J; text: string; fuel: number }

/** A module called the way cellWorkerMain calls it: a fresh instance per call, fuel grant, mv_alloc, mv_run, descriptor. */
function caller(module: WebAssembly.Module, fuel = Math.min(PIN.fuel, CELL_BROWSER_FUEL_CAP)) {
  const grant = BigInt(fuel)
  let seq = 0
  return (op: string, input: unknown): Called => {
    const exports = new WebAssembly.Instance(module, {}).exports as unknown as Exports
    const request = new TextEncoder().encode(cellCanonicalJson({ abi: 1, input, op, seq: ++seq }))
    exports.__mv_fuel_set(grant)
    const pointer = exports.mv_alloc(request.byteLength)
    if (pointer < 64) throw new Error('ALLOC')
    new Uint8Array(exports.memory.buffer, pointer, request.byteLength).set(request)
    exports.__mv_fuel_set(grant)
    const packed = exports.mv_run(pointer, request.byteLength)
    const used = Number(grant - exports.__mv_fuel_remaining())
    const text = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, Number(packed & 0xffff_ffffn), Number(packed >> 32n)))
    return { answer: JSON.parse(text) as J, text, fuel: used }
  }
}
const readCell = async (): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await readFile(new URL('pentora-codec.wasm', CELLS)))
let shipped: ReturnType<typeof caller> | null = null
const cell = async (): Promise<ReturnType<typeof caller>> => {
  shipped ??= caller(await admitCell('pentora-codec', PIN, await readCell()))
  return shipped
}
/** A closed refusal: the code, nothing else (a request that did not parse carries no seq). */
const refused = (called: Called, code: string): void => {
  expect(called.answer).toMatchObject({ abi: 1, code, status: 'refused' })
  expect(Object.keys(called.answer).sort()).toEqual(called.answer.seq === undefined ? ['abi', 'code', 'status'] : ['abi', 'code', 'seq', 'status'])
}

/** Her weights, flattened in the order; and the packets. */
async function herWeights(): Promise<number[]> {
  const bytes = new Uint8Array(await readFile(new URL('kyber/cpu-weights.json', CELLS)))
  expect(sha256(bytes)).toBe(DOT_WEIGHTS_SHA256)
  return carryScalars(JSON.parse(new TextDecoder().decode(bytes)))!
}
const int16 = (values: readonly number[]): string => {
  const bytes = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => bytes.writeInt16LE(v, 2 * i))
  return sha256(bytes)
}
async function dotPackets(): Promise<{ logical_length: number; samples: [string, string][][][] }> {
  const bytes = await readFile(new URL('fixtures/pentora110-qphi72.json', import.meta.url))
  expect(sha256(bytes)).toBe(DOT_PACKETS_SHA256)
  return JSON.parse(bytes.toString('utf8')) as { logical_length: number; samples: [string, string][][][] }
}
const packetsOf = (called: Called): number[][][] => (called.answer.result as { packets: number[][][] }).packets
const valuesOf = (called: Called): number[] => (called.answer.result as { values: number[] }).values

let rng = 0x6d2b79f5
const next = (): number => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return rng >>> 0 }

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
    listen(onMessage, onFailure) { worker.on('message', onMessage); worker.on('error', onFailure); worker.on('messageerror', onFailure) },
    postMessage: (message) => { worker.postMessage(message) },
    async terminate() { await worker.terminate(); worker.removeAllListeners(); workers.delete(worker) },
  }
}
const served = (): typeof fetch => async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/cells/')) return new Response('no', { status: 404 })
  const name = url.pathname.replace(/^\/cells\//, '').replace(/\.wasm$/, '')
  return new Response(Uint8Array.from(await readFile(new URL(`${name}.wasm`, CELLS))), { headers: { 'content-type': 'application/wasm' } })
}
const testHost = (): CellHost => {
  const host = createCellHost({ origin: ORIGIN, fetchImpl: served(), createWorker: nodeCellWorker, now: () => 0 })
  hosts.add(host)
  return host
}
afterEach(async () => {
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  try { await Promise.all([...hosts].map(host => host.dispose())) }
  finally {
    hosts.clear()
    await Promise.all([...workers].map(worker => worker.terminate()))
    workers.clear()
  }
})

/** Walk every function body and global initializer against an integer-only opcode allowlist (as kyber-cpu.spec.ts). */
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

describe('pentora-codec: PENTORA carries her weight CPU\'s weights (an instrument, no authority)', () => {
  it('is pinned: exact size and sha256, one fixed 16-page memory, zero imports, the metered exports, integer opcodes only', async () => {
    const bytes = await readCell()
    expect([bytes.byteLength, sha256(bytes)]).toEqual([PIN.bytes, PIN.sha256])
    expect(PIN.fuel).toBe(250_000_000)
    expect(PIN.fuel).toBeLessThanOrEqual(CELL_BROWSER_FUEL_CAP)
    expect(PIN.ops).toEqual(['pentora.encode', 'pentora.decode', 'pentora.info'])
    expect(inspectWasmMemory('pentora-codec', bytes, CELL_MAX_MEMORY_PAGES)).toEqual({ initial: 16, maximum: 16 })
    const module = await admitCell('pentora-codec', PIN, bytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    expect(WebAssembly.Module.exports(module).map(entry => entry.name).sort()).toEqual([...METERED_CELL_EXPORTS])
    expect(integerOnlyOpcodes(bytes).size).toBeGreaterThan(20)
    const changed = Uint8Array.from(bytes)
    changed[bytes.byteLength >> 1] = (changed[bytes.byteLength >> 1] ?? 0) ^ 0x01
    await expect(admitCell('pentora-codec', PIN, changed)).rejects.toMatchObject({ name: 'CellError', code: 'MODULE_HASH' })
  })

  it('the geometry is the pinned one: same sha256 as tables.ts, and FACE_30_NODES / MENGER_80_NODES match geometry_index_table_v1.json', async () => {
    const b = await build()
    expect(b.GEOMETRY_SHA256).toBe(GEOMETRY_SHA256)
    const rawGeometry = b.geometryBytes()
    expect(sha256(rawGeometry)).toBe(GEOMETRY_SHA256)
    const tables = await readFile(new URL('packages/client/ui-layout/src/client/spatial/aura/tables.ts', REPO), 'utf8')
    expect(/export const GEOMETRY_SHA256 = '([0-9a-f]{64})'/u.exec(tables)?.[1]).toBe(GEOMETRY_SHA256)
    // Independently compute squared radii in Q(phi) (phi^2 = 1 + phi) directly from server/pentora/geometry_index_table_v1.json.
    interface WireCoord { a: [number, number]; b: [number, number] }
    interface WirePoint { global_index: number; coordinates: [WireCoord, WireCoord, WireCoord] }
    const parsed = JSON.parse(new TextDecoder().decode(rawGeometry)) as { centre_index: number; points: WirePoint[] }
    expect(parsed.centre_index).toBe(55)
    const sorted = [...parsed.points].sort((p, q) => p.global_index - q.global_index)
    expect(sorted).toHaveLength(111)
    const radiiFromJson: number[] = []
    for (const point of sorted) {
      if (point.global_index === 55) continue
      // Sum (a + b*phi)^2 = (a^2 + b^2) + (2*a*b + b^2)*phi over the three coordinates using common denominator D^2.
      let rNum = 0n, rDen = 1n, phiNum = 0n, phiDen = 1n
      for (const c of point.coordinates) {
        const [an, ad] = [BigInt(c.a[0]), BigInt(c.a[1])], [bn, bd] = [BigInt(c.b[0]), BigInt(c.b[1])]
        // a^2 + b^2 = (an^2 * bd^2 + bn^2 * ad^2) / (ad^2 * bd^2)
        const cDen = ad * ad * bd * bd
        const cReal = an * an * bd * bd + bn * bn * ad * ad
        // 2*a*b + b^2 = (2*an*bn*ad*bd + bn^2*ad^2) / (ad^2 * bd^2)
        const cPhi = 2n * an * bn * ad * bd + bn * bn * ad * ad
        rNum = rNum * cDen + cReal * rDen; rDen *= cDen
        phiNum = phiNum * cDen + cPhi * phiDen; phiDen *= cDen
      }
      expect(phiNum).toBe(0n)
      expect(rNum % rDen).toBe(0n)
      radiiFromJson.push(Number(rNum / rDen))
    }
    expect(radiiFromJson).toHaveLength(110)
    const faces = radiiFromJson.flatMap((r, n) => (r === 1 ? [n] : []))
    const edges = radiiFromJson.flatMap((r, n) => (r === 2 ? [n] : []))
    const corners = radiiFromJson.flatMap((r, n) => (r === 3 ? [n] : []))
    const menger = radiiFromJson.flatMap((r, n) => (r === 2 || r === 3 ? [n] : []))
    expect([faces.length, edges.length, corners.length, menger.length]).toEqual([30, 60, 20, 80])
    expect([...FACE_30_NODES]).toEqual(faces)
    expect([...MENGER_80_NODES]).toEqual(menger)
    expect([...b.FACE_30_NODES]).toEqual(faces)
    expect([...b.MENGER_80_NODES]).toEqual(menger)
  })

  it('the shipped tables are A from the pinned geometry, and L A_kept = D I is re-proved here with BigInt for all three keep-sets', async () => {
    const b = await build()
    const wat = await readFile(new URL('pentora-codec.wat', CELLS), 'utf8')
    const shippedTables = b.tablesFromWat(wat)
    const { A, radii } = b.evaluationMatrix()
    expect(shippedTables.A).toEqual(A)
    expect(shippedTables.cols).toEqual([...b.EVEN_SLOTS, ...b.ODD_SLOTS])
    expect(shippedTables.mengerNodes).toEqual([...MENGER_80_NODES])
    expect(radii.filter(r => r === 1)).toHaveLength(30)
    expect([b.EVEN_SLOTS.length, b.ODD_SLOTS.length]).toEqual([30, 42])
    const packetMax = A.reduce((m, row) => { const s = row.reduce((t, v) => t + (v < 0n ? -v : v), 0n); return s > m ? s : m }, 0n) * 32768n
    expect(shippedTables.packetMax).toBe(packetMax)
    const expectedNodes: Record<string, readonly number[]> = {
      'all': Array.from({ length: 110 }, (_, n) => n),
      'drop-0-9': Array.from({ length: 100 }, (_, i) => i + 10),
      'menger-80': MENGER_80_NODES,
    }
    for (const keep of ['all', 'drop-0-9', 'menger-80'] as const) {
      const k = shippedTables.keeps[keep]!
      expect(k.keptNodes).toEqual([...expectedNodes[keep]!])
      expect(k.D > 0n).toBe(true)
      const keptRows = new Set<number>()
      for (const n of k.keptNodes) for (let m = 0; m < 8; m += 1) keptRows.add(8 * n + m)
      expect(keptRows.size).toBe(k.keptNodes.length * 8)
      // The full 72 x 880 left inverse, zero outside the chosen rows; no chosen row belongs to any dropped node.
      const L = Array.from({ length: 72 }, () => new Map<number, bigint>())
      for (const [slots, part] of [[b.EVEN_SLOTS, k.even], [b.ODD_SLOTS, k.odd]] as const) {
        expect(part.rows.every(r => keptRows.has(r))).toBe(true)
        if (keep === 'menger-80') expect(part.rows.every(r => radii[Math.floor(r / 8)] !== 1)).toBe(true)
        slots.forEach((slot, i) => { part.rows.forEach((r, m) => { if (part.L[i]![m] !== 0n) L[slot]!.set(r, part.L[i]![m]!) }) })
      }
      for (let i = 0; i < 72; i += 1) {
        for (const r of L[i]!.keys()) expect(keptRows.has(r)).toBe(true)
        for (let j = 0; j < 72; j += 1) {
          let sum = 0n
          for (const [r, v] of L[i]!) sum += v * A[r]![j]!
          if (sum !== (i === j ? k.D : 0n)) throw new Error(`${keep}: (L A)[${String(i)}][${String(j)}] = ${String(sum)}`)
        }
      }
    }
    // menger-80 uses the exact same 72-row Menger solver as "all" (23-bit D = 6,082,560) because face-centre rows (r^2 = 1)
    // mix parities and are never chosen by L; menger-80 differs at runtime by checking 640 Menger rows instead of all 880.
    expect(shippedTables.keeps['menger-80']!.D).toBe(6_082_560n)
    expect(shippedTables.keeps['menger-80']!.D.toString(2)).toHaveLength(23)
    expect(shippedTables.keeps['menger-80']!.D).toBe(shippedTables.keeps['all']!.D)
    expect(shippedTables.keeps['menger-80']!.even).toEqual(shippedTables.keeps['all']!.even)
    expect(shippedTables.keeps['menger-80']!.odd).toEqual(shippedTables.keeps['all']!.odd)
  }, 60_000)

  it('structured carrier vs MDS bounds: Menger twin lines, 40-packet five-great-circle loss at rank 70/72, 60 edges = 72, 2 cubes = 72, 1 cube = 50/72', async () => {
    const b = await build()
    const { A, radii } = b.evaluationMatrix()
    interface Incidence { cube_id: number }
    interface GeoPoint { global_index: number; incidences: Incidence[] }
    const geo = JSON.parse(new TextDecoder().decode(b.geometryBytes())) as { points: GeoPoint[] }
    const sorted = [...geo.points].sort((p, q) => p.global_index - q.global_index).filter(p => p.global_index !== 55)
    expect(sorted).toHaveLength(110)

    const gcd = (x: bigint, y: bigint): bigint => {
      let a = x < 0n ? -x : x
      let c = y < 0n ? -y : y
      while (c !== 0n) [a, c] = [c, a % c]
      return a
    }
    const reduceRow = (row: bigint[], from: number): void => {
      let g = 0n
      for (let j = from; j < row.length; j += 1) {
        if (row[j] !== 0n) { g = gcd(g, row[j]!); if (g === 1n) return }
      }
      if (g > 1n) for (let j = from; j < row.length; j += 1) row[j] = row[j]! / g
    }
    /** Exact Q-rank over BigInt (fraction-free row reduction with row-GCD normalization, zero floats). */
    const exactRankOfNodes = (nodes: readonly number[]): number => {
      const M: bigint[][] = []
      for (const n of nodes) {
        for (let m = 0; m < 8; m += 1) {
          const row = A[8 * n + m]!
          if (row.some(v => v !== 0n)) {
            const copy = [...row]
            reduceRow(copy, 0)
            M.push(copy)
          }
        }
      }
      let rank = 0
      for (let col = 0; col < 72 && rank < M.length; col += 1) {
        let piv = -1
        for (let i = rank; i < M.length; i += 1) if (M[i]![col] !== 0n) { piv = i; break }
        if (piv < 0) continue
        if (piv !== rank) [M[rank], M[piv]] = [M[piv]!, M[rank]!]
        const p = M[rank]![col]!
        for (let i = rank + 1; i < M.length; i += 1) {
          const f = M[i]![col]!
          if (f === 0n) continue
          const g = gcd(p, f)
          const mp = p / g
          const mf = f / g
          M[i]![col] = 0n
          for (let j = col + 1; j < 72; j += 1) M[i]![j] = M[i]![j]! * mp - M[rank]![j]! * mf
          reduceRow(M[i]!, col + 1)
        }
        rank += 1
      }
      return rank
    }

    // 1. Antipodal mirror-twin parity on all 40 Menger lines (n and 109 - n): even slots match, odd slots negate,
    // so losing <= 11 Menger packets can kill at most 5 of the 40 twin lines. Exhaustive 40 choose 5 = 658,008 is
    // `SOURCE: CODE-VERDICT.md` (not re-run exhaustively here); below we verify mirror-twin parity on all 40 lines,
    // exact rank 72 on one half-sphere, and sampled 11-packet Menger losses (5 dead twin lines + 1 extra node = 69 kept, RAN).
    const evenSet = new Set<number>(b.EVEN_SLOTS)
    const mengerHalfLines = MENGER_80_NODES.filter(n => n < 55)
    expect(mengerHalfLines).toHaveLength(40)
    for (const n of mengerHalfLines) {
      expect(radii[109 - n]).toBe(radii[n])
      for (let m = 0; m < 8; m += 1) {
        for (let j = 0; j < 72; j += 1) {
          expect(A[8 * (109 - n) + m]![j]).toBe(evenSet.has(j) ? A[8 * n + m]![j] : -A[8 * n + m]![j]!)
        }
      }
    }
    expect(exactRankOfNodes(mengerHalfLines)).toBe(72)
    for (let sample = 0; sample < 8; sample += 1) {
      const deadLines = Array.from({ length: 5 }, (_, k) => mengerHalfLines[(sample * 7 + k * 9) % 40]!)
      const extraHalf = mengerHalfLines[(sample * 7 + 23) % 40]!
      const lost11 = new Set<number>([...deadLines, ...deadLines.map(n => 109 - n), extraHalf])
      expect(lost11.size).toBe(11)
      const kept69 = MENGER_80_NODES.filter(n => !lost11.has(n))
      expect(kept69).toHaveLength(69)
      expect(exactRankOfNodes(kept69)).toBe(72)
    }

    // 2. Non-MDS upper counterexample: one specific loss of 40 packets lying on five great circles (20 corners +
    // 16 edge-centres + 4 face-centres) leaves 70 kept packets whose exact Q-rank is 70/72, defeating recovery.
    const lost40 = [
      0, 1, 10, 11, 12, 13, 15, 16, 17, 18, 27, 28, 38, 40, 42, 44, 49, 51, 52, 53,
      56, 57, 58, 60, 65, 67, 69, 71, 81, 82, 91, 92, 93, 94, 96, 97, 98, 99, 108, 109,
    ]
    expect(lost40).toHaveLength(40)
    expect([
      lost40.filter(n => radii[n] === 3).length,
      lost40.filter(n => radii[n] === 2).length,
      lost40.filter(n => radii[n] === 1).length,
    ]).toEqual([20, 16, 4])
    const lostSet = new Set(lost40)
    const kept70 = Array.from({ length: 110 }, (_, n) => n).filter(n => !lostSet.has(n))
    expect(kept70).toHaveLength(70)
    expect(exactRankOfNodes(kept70)).toBe(70)

    // 3. Structured shells & cubes: 60 edge-centres = rank 72; 1 cube (26 points) = rank 50/72; any 2 cubes (50 points) = rank 72.
    const edgeCentres60 = radii.flatMap((r, n) => (r === 2 ? [n] : []))
    expect(edgeCentres60).toHaveLength(60)
    expect(exactRankOfNodes(edgeCentres60)).toBe(72)
    const cubeNodes = Array.from({ length: 5 }, (_, cid) =>
      sorted.flatMap((p, n) => (p.incidences.some(inc => inc.cube_id === cid) ? [n] : [])))
    for (const single of cubeNodes) {
      expect(single).toHaveLength(26)
      expect(exactRankOfNodes(single)).toBe(50)
    }
    for (let c1 = 0; c1 < 5; c1 += 1) {
      for (let c2 = c1 + 1; c2 < 5; c2 += 1) {
        const pair = [...new Set([...cubeNodes[c1]!, ...cubeNodes[c2]!])].sort((p, q) => p - q)
        expect(pair).toHaveLength(50)
        expect(exactRankOfNodes(pair)).toBe(72)
      }
    }

    // 4. Two whole cubes (50 points, 3 of 5 cubes lost) recover all 1,329 real Kyber CPU weights from the packets
    //    by this test's own BigInt solver (not by pentora.decode, which accepts only "all", "drop-0-9", and "menger-80").
    const twoCubes = [...new Set([...cubeNodes[0]!, ...cubeNodes[1]!])].sort((p, q) => p - q)
    const work = twoCubes.flatMap(n => Array.from({ length: 8 }, (_, m) => 8 * n + m))
      .filter(r => A[r]!.some(v => v !== 0n))
      .map(r => ({ r, row: [...A[r]!] }))
    const chosenRows: number[] = []
    for (let col = 0, rank = 0; col < 72 && rank < work.length; col += 1) {
      let piv = -1
      for (let i = rank; i < work.length; i += 1) if (work[i]!.row[col] !== 0n) { piv = i; break }
      if (piv < 0) throw new Error('twoCubes rank < 72')
      if (piv !== rank) [work[rank], work[piv]] = [work[piv]!, work[rank]!]
      chosenRows.push(work[rank]!.r)
      const p = work[rank]!.row[col]!
      for (let i = rank + 1; i < work.length; i += 1) {
        const f = work[i]!.row[col]!
        if (f === 0n) continue
        const g = gcd(p, f), mp = p / g, mf = f / g
        for (let j = col; j < 72; j += 1) work[i]!.row[j] = work[i]!.row[j]! * mp - work[rank]!.row[j]! * mf
        reduceRow(work[i]!.row, col + 1)
      }
      rank += 1
    }
    const aug = chosenRows.map((r, idx) => {
      const line = Array<bigint>(144).fill(0n)
      for (let j = 0; j < 72; j += 1) line[j] = A[r]![j]!
      line[72 + idx] = 1n
      return line
    })
    for (let col = 0; col < 72; col += 1) {
      let piv = col
      while (aug[piv]![col] === 0n) piv += 1
      if (piv !== col) [aug[col], aug[piv]] = [aug[piv]!, aug[col]!]
      if (aug[col]![col]! < 0n) for (let j = col; j < 144; j += 1) aug[col]![j] = -aug[col]![j]!
      const p = aug[col]![col]!
      for (let i = 0; i < 72; i += 1) {
        if (i === col || aug[i]![col] === 0n) continue
        const f = aug[i]![col]!, g = gcd(p, f), mp = p / g, mf = f / g
        for (let j = 0; j < 144; j += 1) aug[i]![j] = aug[i]![j]! * mp - aug[col]![j]! * mf
        reduceRow(aug[i]!, 0)
      }
    }
    const dot = await dotPackets()
    const weights = await herWeights()
    const recoveredTwoCubes: number[] = []
    for (let blk = 0; blk < 19; blk += 1) {
      const y = chosenRows.map((r) => {
        const [num, den] = dot.samples[Math.floor(r / 8)]![blk]![r % 8]!.map(BigInt) as [bigint, bigint]
        return (num * 13824n) / den
      })
      for (let i = 0; i < 72 && recoveredTwoCubes.length < 1329; i += 1) {
        let sum = 0n
        for (let k = 0; k < 72; k += 1) sum += aug[i]![72 + k]! * y[k]!
        expect(sum % aug[i]![i]!).toBe(0n)
        recoveredTwoCubes.push(Number(sum / aug[i]![i]!))
      }
    }
    expect(recoveredTwoCubes).toEqual(weights)
    expect(int16(recoveredTwoCubes)).toBe(DOT_INT16_SHA256)
  }, 60_000)

  it('the build\'s check mode: the WAT\'s tables and the metered bytes are identical to a rebuild through the pinned skillsmith', async () => {
    const b = await build()
    const wat = await readFile(new URL('pentora-codec.wat', CELLS), 'utf8')
    const generated = b.generateTables()
    expect(b.watWithTables(wat, generated.text)).toBe(wat)
    expect(generated.facts.keep['all']).toMatchObject({ kept: 110, dBits: 23 })
    expect(generated.facts.keep['drop-0-9']).toMatchObject({ kept: 100, dBits: 32 })
    expect(generated.facts.keep['menger-80']).toMatchObject({ kept: 80, dBits: 23 })
    expect(sha256(b.buildPentoraCodecCell(wat).metered)).toBe(PIN.sha256)
  }, 120_000)

  it('her real weights: the encoding equals the reference packets value for value; drop 0..9 or all 30 face-centres (menger-80), all 1,329 equal', async () => {
    const values = await herWeights()
    expect(values).toHaveLength(1329)
    expect(int16(values)).toBe(DOT_INT16_SHA256)
    const run = await cell()
    const encoded = run('pentora.encode', { values })
    expect(encoded.answer).toMatchObject({ abi: 1, status: 'ok', result: { blocks: 19, count: 1329, profile: 'pentora110-qphi72', scale: 13824 } })
    const packets = packetsOf(encoded)
    const dot = await dotPackets()
    expect(dot.logical_length).toBe(1329)
    let compared = 0
    for (let n = 0; n < 110; n += 1) {
      for (let blk = 0; blk < 19; blk += 1) {
        for (let m = 0; m < 8; m += 1) {
          const [num, den] = dot.samples[n]![blk]![m]!.map(BigInt) as [bigint, bigint]
          if (BigInt(packets[n]![blk]![m]!) * den !== num * 13824n) throw new Error(`packet ${String(n)}/${String(blk)}/${String(m)}`)
          compared += 1
        }
      }
    }
    expect(compared).toBe(16_720)
    const dropped = run('pentora.decode', { count: 1329, keep: 'drop-0-9', packets: packets.slice(10) })
    expect(dropped.answer).toMatchObject({ status: 'ok', result: { blocks: 19, keep: 'drop-0-9', kept: 100, rank: 72, residual: 'exact' } })
    expect(valuesOf(dropped)).toEqual(values)
    expect(int16(valuesOf(dropped))).toBe(DOT_INT16_SHA256)
    const menger = run('pentora.decode', { count: 1329, keep: 'menger-80', packets: MENGER_80_NODES.map(n => packets[n]!) })
    expect(menger.answer).toMatchObject({ status: 'ok', result: { blocks: 19, keep: 'menger-80', kept: 80, rank: 72, residual: 'exact' } })
    expect(valuesOf(menger)).toEqual(values)
    expect(int16(valuesOf(menger))).toBe(DOT_INT16_SHA256)
    const all = run('pentora.decode', { count: 1329, keep: 'all', packets })
    expect(all.answer).toMatchObject({ status: 'ok', result: { blocks: 19, keep: 'all', kept: 110, rank: 72, residual: 'exact' } })
    expect(valuesOf(all)).toEqual(values)
    // The own packets, as numerators over 13,824, decode the same under both drop-0-9 and menger-80.
    const fromDot = dot.samples.map(node => node.map(block => block.map(([num, den]) => Number(BigInt(num) * 13824n / BigInt(den)))))
    expect(valuesOf(run('pentora.decode', { count: 1329, keep: 'drop-0-9', packets: fromDot.slice(10) }))).toEqual(values)
    expect(valuesOf(run('pentora.decode', { count: 1329, keep: 'menger-80', packets: MENGER_80_NODES.map(n => fromDot[n]!) }))).toEqual(values)
    expect(encoded.fuel + dropped.fuel).toBeLessThan(PIN.fuel)
    expect(encoded.fuel + menger.fuel).toBeLessThan(PIN.fuel)
  }, 60_000)

  it('one corrupted packet component is PENTORA_INCONSISTENT, wherever it is, and dropped packets (including all 30 face-centres) are never read', async () => {
    const values = await herWeights()
    const run = await cell()
    const packets = packetsOf(run('pentora.encode', { values }))
    const b = await build()
    const shippedKeeps = b.tablesFromWat(await readFile(new URL('pentora-codec.wat', CELLS), 'utf8')).keeps
    const k = shippedKeeps['drop-0-9']!
    const km = shippedKeeps['menger-80']!
    const { A } = b.evaluationMatrix()
    const chosen = k.even.rows[3]!
    const unchosen = [...Array(880).keys()].find(r => r >= 80 && !k.even.rows.includes(r) && !k.odd.rows.includes(r)
      && A[r]!.some(v => v !== 0n))!
    const alwaysZero = [...Array(880).keys()].find(r => r >= 80 && A[r]!.every(v => v === 0n))!
    for (const [row, blk, delta] of [[chosen, 0, 1], [unchosen, 7, 1], [alwaysZero, 18, 1], [chosen, 18, -1], [879, 5, 13824]] as const) {
      const bad = structuredClone(packets)
      const node = Math.floor(row / 8)
      bad[node]![blk]![row % 8]! += delta
      refused(run('pentora.decode', { count: 1329, keep: 'drop-0-9', packets: bad.slice(10) }), 'PENTORA_INCONSISTENT')
      refused(run('pentora.decode', { count: 1329, keep: 'all', packets: bad }), 'PENTORA_INCONSISTENT')
    }
    // Menger-80 on 19 blocks: chosen row, unchosen nonzero Menger row, and always-zero Menger row across blocks.
    const mengerRowSet = new Set(MENGER_80_NODES.flatMap(n => Array.from({ length: 8 }, (_, m) => 8 * n + m)))
    const mChosen = km.odd.rows[5]!
    const mUnchosen = [...mengerRowSet].find(r => !km.even.rows.includes(r) && !km.odd.rows.includes(r) && A[r]!.some(v => v !== 0n))!
    const mZero = [...mengerRowSet].find(r => A[r]!.every(v => v === 0n))!
    for (const [row, blk, delta] of [[mChosen, 0, 1], [mUnchosen, 9, -1], [mZero, 18, 1], [mChosen, 18, 13824]] as const) {
      const bad = structuredClone(packets)
      bad[Math.floor(row / 8)]![blk]![row % 8]! += delta
      refused(run('pentora.decode', { count: 1329, keep: 'menger-80', packets: MENGER_80_NODES.map(n => bad[n]!) }), 'PENTORA_INCONSISTENT')
    }
    // Exhaustive Menger-80 check: corrupting ANY 1 component (0..7) of ANY of the 80 kept Menger packets returns PENTORA_INCONSISTENT.
    const oneBlock = packetsOf(run('pentora.encode', { values: values.slice(0, 72) }))
    const mengerOne = MENGER_80_NODES.map(n => oneBlock[n]!)
    for (let kIdx = 0; kIdx < 80; kIdx += 1) {
      for (let m = 0; m < 8; m += 1) {
        const orig = mengerOne[kIdx]![0]![m]!
        mengerOne[kIdx]![0]![m] = orig + 1
        refused(run('pentora.decode', { count: 72, keep: 'menger-80', packets: mengerOne }), 'PENTORA_INCONSISTENT')
        mengerOne[kIdx]![0]![m] = orig
      }
    }
    // Dropped packets are never passed to pentora.decode: nodes 0..9 for drop-0-9.
    const outside = structuredClone(packets)
    outside[3]![0]![0]! += 1
    expect(valuesOf(run('pentora.decode', { count: 1329, keep: 'drop-0-9', packets: outside.slice(10) }))).toEqual(values)
  }, 60_000)

  it('a cell built with one wrong table entry (in L, T_MENGER, or A) refuses; it never answers a wrong value', async () => {
    const b = await build()
    const wat = await readFile(new URL('pentora-codec.wat', CELLS), 'utf8')
    const values = await herWeights()
    const packets = packetsOf((await cell())('pentora.encode', { values }))
    const mengerPackets = MENGER_80_NODES.map(n => packets[n]!)
    const start = wat.indexOf('\n', wat.indexOf('(data (i32.const 131072)'))
    const end = wat.indexOf(')', start)
    const text = wat.slice(start, end)
    const blob = Buffer.from(text.replace(/[\s"]/gu, ''), 'base64')
    const at = (name: string): number => Number(new RegExp(`\\(global \\$${name} i32 \\(i32\\.const (\\d+)\\)\\)`, 'u').exec(wat)![1]) - 8192
    const faulty = (patch: (bytes: Buffer) => void): string => {
      const copy = Buffer.from(blob)
      patch(copy)
      const b64 = copy.toString('base64')
      const lines: string[] = []
      for (let i = 0; i < b64.length; i += 96) lines.push(`    "${b64.slice(i, i + 96)}"`)
      return wat.slice(0, start) + '\n' + lines.join('\n') + wat.slice(end)
    }
    // L: one entry of drop-0-9's odd block, all's even block, and menger-80's odd block, each changed by one.
    const lDrop = faulty((bytes) => { const o = at('T_KEEP1') + 152 + 3600 + 4 * 100; bytes.writeInt32LE(bytes.readInt32LE(o) + 1, o) })
    const lAll = faulty((bytes) => { const o = at('T_KEEP0') + 152 + 4 * 31; bytes.writeInt32LE(bytes.readInt32LE(o) + 1, o) })
    const lMenger = faulty((bytes) => { const o = at('T_KEEP2') + 152 + 3600 + 4 * 50; bytes.writeInt32LE(bytes.readInt32LE(o) + 1, o) })
    // T_MENGER: map Menger packet 14 (true node 15) onto face-centre node 14 instead.
    const mMap = faulty((bytes) => { bytes[at('T_MENGER') + 14] = 14 })
    // A: one nonzero entry of a kept row, changed by one.
    const aOne = faulty((bytes) => { const o = at('T_EVALS') + 2 * 5000; bytes.writeInt16LE(bytes.readInt16LE(o) + 1, o) })
    for (const source of [lDrop, lAll, lMenger, mMap, aOne]) {
      expect(source).not.toBe(wat)
      const run = caller(new WebAssembly.Module(b.buildPentoraCodecCell(source).metered))
      for (const [keep, sent] of [['drop-0-9', packets.slice(10)], ['all', packets], ['menger-80', mengerPackets]] as const) {
        const called = run('pentora.decode', { count: 1329, keep, packets: sent })
        if (called.answer.status === 'ok') {
          // Only a change that no packet of this keep-set ever reads may answer, and then only the true values.
          expect(valuesOf(called)).toEqual(values)
        } else {
          expect(['PENTORA_INCONSISTENT', 'PENTORA_NOT_INTEGER']).toContain(called.answer.code)
          expect(called.text).not.toContain('values')
        }
      }
    }
    // The L and T_MENGER changes are read by their keep-set: those refuse.
    expect(caller(new WebAssembly.Module(b.buildPentoraCodecCell(lDrop).metered))('pentora.decode',
      { count: 1329, keep: 'drop-0-9', packets: packets.slice(10) }).answer.status).toBe('refused')
    expect(caller(new WebAssembly.Module(b.buildPentoraCodecCell(lMenger).metered))('pentora.decode',
      { count: 1329, keep: 'menger-80', packets: mengerPackets }).answer.status).toBe('refused')
    expect(caller(new WebAssembly.Module(b.buildPentoraCodecCell(mMap).metered))('pentora.decode',
      { count: 1329, keep: 'menger-80', packets: mengerPackets }).answer.status).toBe('refused')
  }, 240_000)

  it('any keep-set but the three is PENTORA_KEEP_UNSUPPORTED; encode carries every node, so only "all"', async () => {
    const run = await cell()
    const packets = packetsOf(run('pentora.encode', { values: [1, 2, 3] }))
    for (const keep of ['drop-0-8', 'drop-1-10', 'menger-79', 'menger-81', 'faces', 'none', 'ALL', 'MENGER-80', 'drop-0-9 ', 'menger-80 ', '', 'all\u0000', 'drop\\-0-9', 'menger\\-80']) {
      refused(run('pentora.decode', { count: 3, keep, packets }), 'PENTORA_KEEP_UNSUPPORTED')
    }
    refused(run('pentora.encode', { keep: 'drop-0-9', values: [1] }), 'PENTORA_KEEP_UNSUPPORTED')
    refused(run('pentora.encode', { keep: 'menger-80', values: [1] }), 'PENTORA_KEEP_UNSUPPORTED')
    refused(run('pentora.encode', { keep: 'some', values: [1] }), 'PENTORA_KEEP_UNSUPPORTED')
    expect(run('pentora.encode', { keep: 'all', values: [1] }).answer).toMatchObject({ status: 'ok', result: { blocks: 1, count: 1 } })
    expect(valuesOf(run('pentora.decode', { count: 3, keep: 'all', packets }))).toEqual([1, 2, 3])
    expect(valuesOf(run('pentora.decode', { count: 3, keep: 'menger-80', packets: MENGER_80_NODES.map(n => packets[n]!) }))).toEqual([1, 2, 3])
  })

  it('random integer blocks within the bound round-trip exactly, all three keep-sets (2,400 blocks)', async () => {
    const run = await cell()
    let blocks = 0
    for (let call = 0; call < 100; call += 1) {
      const count = call % 5 === 0 ? 1 + (next() % 1728) : 1728
      const values = Array.from({ length: count }, () => {
        const pick = next() % 8
        return pick === 0 ? -32768 : pick === 1 ? 32767 : (next() % 65536) - 32768
      })
      const packets = packetsOf(run('pentora.encode', { values }))
      const keep = (['drop-0-9', 'all', 'menger-80'] as const)[call % 3]!
      const sent = keep === 'all' ? packets : keep === 'drop-0-9' ? packets.slice(10) : MENGER_80_NODES.map(n => packets[n]!)
      const decoded = run('pentora.decode', { count, keep, packets: sent })
      if (decoded.answer.status !== 'ok' || valuesOf(decoded).some((v, i) => v !== values[i])) throw new Error(`call ${String(call)}: ${decoded.text.slice(0, 200)}`)
      blocks += Math.ceil(count / 72)
    }
    expect(blocks).toBeGreaterThanOrEqual(2000)
  }, 120_000)

  it('values at the bound are carried; beyond it they are refused, at encode and at decode', async () => {
    const run = await cell()
    const edge = [-32768, 32767, 0, -1, 1, 32766, -32767]
    const edgePackets = packetsOf(run('pentora.encode', { values: edge }))
    expect(valuesOf(run('pentora.decode', { count: 7, keep: 'drop-0-9', packets: edgePackets.slice(10) }))).toEqual(edge)
    expect(valuesOf(run('pentora.decode', { count: 7, keep: 'menger-80', packets: MENGER_80_NODES.map(n => edgePackets[n]!) }))).toEqual(edge)
    for (const value of [-32769, 32768, 65535, -9007199254740991]) refused(run('pentora.encode', { values: [0, value] }), 'PENTORA_SHAPE')
    // Packets that are exactly A x for an x with one slot at 32768 (consistent, integer, beyond the bound).
    const { A } = (await build()).evaluationMatrix()
    const beyond = (slot: number, value: bigint): number[][][] =>
      Array.from({ length: 110 }, (_, n) => [Array.from({ length: 8 }, (_, m) => Number(A[8 * n + m]![slot]! * value))])
    expect(valuesOf(run('pentora.decode', { count: 72, keep: 'all', packets: beyond(40, -32768n) }))[40]).toBe(-32768)
    refused(run('pentora.decode', { count: 72, keep: 'all', packets: beyond(40, 32768n) }), 'PENTORA_NOT_INTEGER')
    refused(run('pentora.decode', { count: 72, keep: 'drop-0-9', packets: beyond(70, -32769n).slice(10) }), 'PENTORA_NOT_INTEGER')
    refused(run('pentora.decode', { count: 72, keep: 'menger-80', packets: MENGER_80_NODES.map(n => beyond(40, 32768n)[n]!) }), 'PENTORA_NOT_INTEGER')
    // Consistent packets whose solution is not an integer: column 0 of A is all multiples of 13,824, so A e_0 / 2 is
    // a whole packet set whose only solution is one half.
    const half = Array.from({ length: 110 }, (_, n) => [Array.from({ length: 8 }, (_, m) => Number(A[8 * n + m]![0]! / 2n))])
    refused(run('pentora.decode', { count: 72, keep: 'all', packets: half }), 'PENTORA_NOT_INTEGER')
    refused(run('pentora.decode', { count: 72, keep: 'drop-0-9', packets: half.slice(10) }), 'PENTORA_NOT_INTEGER')
    refused(run('pentora.decode', { count: 72, keep: 'menger-80', packets: MENGER_80_NODES.map(n => half[n]!) }), 'PENTORA_NOT_INTEGER')
  })

  it('closed refusals for every other shape; info answers the instrument\'s facts', async () => {
    const run = await cell()
    const packets = packetsOf(run('pentora.encode', { values: Array.from({ length: 100 }, (_, i) => i - 50) }))
    expect(packets).toHaveLength(110)
    expect(packets.every(node => node.length === 2 && node.every(block => block.length === 8))).toBe(true)
    const decode = (input: unknown): Called => run('pentora.decode', input)
    // the count must fit the blocks; padding past the count must decode to zero
    for (const count of [72, 145, 0, 1729]) refused(decode({ count, keep: 'all', packets }), 'PENTORA_SHAPE')
    refused(decode({ count: 99, keep: 'all', packets }), 'PENTORA_SHAPE')
    expect(valuesOf(decode({ count: 100, keep: 'all', packets }))).toHaveLength(100)
    // node count, blocks per node, components per block, component size
    refused(decode({ count: 100, keep: 'all', packets: packets.slice(1) }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'drop-0-9', packets }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'menger-80', packets }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'menger-80', packets: packets.slice(10) }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'menger-80', packets: packets.slice(0, 79) }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'menger-80', packets: packets.slice(0, 81) }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'all', packets: packets.map((node, n) => (n === 5 ? node.slice(1) : node)) }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'all', packets: packets.map((node, n) => (n === 5 ? [node[0]!.slice(1), node[1]!] : node)) }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'all', packets: packets.map((node, n) => (n === 5 ? [[...node[0]!, 0], node[1]!] : node)) }), 'PENTORA_SHAPE')
    refused(decode({ count: 72, keep: 'all', packets: Array.from({ length: 110 }, () => [[5881724929, 0, 0, 0, 0, 0, 0, 0]]) }), 'PENTORA_SHAPE')
    refused(decode({ count: 72, keep: 'all', packets: Array.from({ length: 110 }, (): number[][] => []) }), 'PENTORA_SHAPE')
    const tooMany = Array.from({ length: 110 }, () => Array.from({ length: 25 }, (): number[] => Array<number>(8).fill(0)))
    refused(decode({ count: 1, keep: 'all', packets: tooMany }), 'PENTORA_SHAPE')
    // a missing or extra key, the wrong op for the input, no values
    refused(decode({ keep: 'all', packets }), 'PENTORA_SHAPE')
    refused(decode({ count: 100, keep: 'all', packets, extra: 1 }), 'PENTORA_SHAPE')
    refused(run('pentora.encode', { values: [] }), 'PENTORA_SHAPE')
    refused(run('pentora.encode', { values: Array(1729).fill(0) }), 'PENTORA_SHAPE')
    refused(run('pentora.encode', { count: 1, keep: 'all', packets }), 'PENTORA_SHAPE')
    refused(run('pentora.info', { values: [1] }), 'PENTORA_SHAPE')
    refused(run('pentora.decode', {}), 'PENTORA_SHAPE')
    refused(run('pentora.transmute', {}), 'OP_UNKNOWN')
    expect(run('pentora.encode', { values: [1, 'x'] }).answer).toEqual({ abi: 1, code: 'PENTORA_SHAPE', status: 'refused' })
    // All zero packets are consistent and decode to zeros.
    expect(valuesOf(decode({ count: 72, keep: 'all', packets: Array.from({ length: 110 }, () => [Array(8).fill(0)]) }))).toEqual(Array(72).fill(0))
    expect(valuesOf(decode({ count: 72, keep: 'menger-80', packets: Array.from({ length: 80 }, () => [Array(8).fill(0)]) }))).toEqual(Array(72).fill(0))
    expect(run('pentora.info', {}).answer).toEqual({ abi: 1, seq: expect.any(Number) as number, status: 'ok', result: {
      blockSize: 72,
      denominatorBits: { 'all': 23, 'drop-0-9': 32, 'menger-80': 23 },
      geometrySha256: GEOMETRY_SHA256,
      keepSets: ['all', 'drop-0-9', 'menger-80'],
      kept: { 'all': 110, 'drop-0-9': 100, 'menger-80': 80 },
      maxBlocks: 24, nodes: 110, packetMax: 5881724928, profile: 'pentora110-qphi72', rank: 72, scale: 13824, valueMax: 32767, valueMin: -32768,
    } })
  })

  it('the worst call fits its fuel: a full 24-block decode of extreme values across all three keep-sets', async () => {
    const run = await cell()
    const values = Array.from({ length: 1728 }, (_, i) => [32767, -32768, -32767, 32767, -32768][i % 5]!)
    const encoded = run('pentora.encode', { values })
    const packets = packetsOf(encoded)
    for (const [keep, sent] of [
      ['all', packets],
      ['drop-0-9', packets.slice(10)],
      ['menger-80', MENGER_80_NODES.map(n => packets[n]!)],
    ] as const) {
      const decoded = run('pentora.decode', { count: 1728, keep, packets: sent })
      expect(valuesOf(decoded)).toEqual(values)
      expect(decoded.fuel).toBeLessThan(160_000_000)
      expect(decoded.fuel).toBeLessThan(PIN.fuel)
    }
    // A starved grant ends in the host's fuel trap, never in an answer.
    const starved = caller(await admitCell('pentora-codec', PIN, await readCell()), 1_000_000)
    expect(() => starved('pentora.decode', { count: 1728, keep: 'all', packets })).toThrow()
    expect(() => starved('pentora.decode', { count: 1728, keep: 'menger-80', packets: MENGER_80_NODES.map(n => packets[n]!) })).toThrow()
  }, 60_000)

  it('runs through the real host: the pin, a separate worker (reused across calls without face-row bleed), and the journal', async () => {
    const host = testHost()
    expect(host.list().find(row => row.cell === 'pentora-codec')).toMatchObject({ cell: 'pentora-codec', sha256: PIN.sha256, ops: PIN.ops })
    expect(await host.invoke('pentora-codec', 'pentora.info', {}, 'x6_cell')).toMatchObject({ ok: true, result: { geometrySha256: GEOMETRY_SHA256 } })
    expect(await host.invoke('pentora-codec', 'pentora.decode', { count: 1, keep: 'drop-1-10', packets: [] }, 'x6_cell'))
      .toMatchObject({ ok: false, code: 'PENTORA_KEEP_UNSUPPORTED' })
    // Populate all 880 packet rows on the retained worker instance with one vector, then decode a second vector via menger-80:
    // stale face-centre rows in linear memory are never read.
    const encA = await host.invoke('pentora-codec', 'pentora.encode', { values: [111, -222, 333] }, 'x6_cell')
    expect(encA.ok).toBe(true)
    const pktsA = ((encA as { result: { packets: number[][][] } }).result).packets
    expect(await host.invoke('pentora-codec', 'pentora.decode', { count: 3, keep: 'all', packets: pktsA }, 'x6_cell'))
      .toMatchObject({ ok: true, result: { values: [111, -222, 333] } })
    const encB = await host.invoke('pentora-codec', 'pentora.encode', { values: [-444, 555, -666] }, 'x6_cell')
    const pktsB = ((encB as { result: { packets: number[][][] } }).result).packets
    expect(await host.invoke('pentora-codec', 'pentora.decode', { count: 3, keep: 'menger-80', packets: MENGER_80_NODES.map(n => pktsB[n]!) }, 'x6_cell'))
      .toMatchObject({ ok: true, result: { keep: 'menger-80', kept: 80, values: [-444, 555, -666] } })
  }, 60_000)
})

describe('x6_cell carry: the Kyber Kernel experiment on her own weights in one call', () => {
  type Served = (call: { method: string; path: string }) => Promise<Response | null>
  const serveKyber = (override: Record<string, Uint8Array> = {}): Served => async (call) => {
    if (call.method !== 'GET' || !call.path.startsWith('/cells/kyber/')) return null
    const bytes = override[call.path] ?? new Uint8Array(await readFile(new URL(call.path.slice('/cells/'.length), CELLS)))
    return new Response(Uint8Array.from(bytes))
  }
  async function mount(respond: ReturnType<typeof serveKyber>) {
    const host = testHost()
    vi.spyOn(wasmCells, 'workerCellHost').mockReturnValue(host)
    const m = await mountE4({ respond: call => call.method === 'GET' && call.path === '/api/build'
      ? Response.json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: null }) : respond(call) })
    return { cell: m.tool('x6_cell'), host }
  }

  it('carry end to end: drop 0..9, drop all 30 face-centres (menger-80), and drop none — all 1,329 weights back, exact int16 sha256', async () => {
    const record = new Uint8Array(await readFile(new URL('kyber/skills/countdown.json', CELLS)))
    expect(await skillId(record)).toBe(CARRY_RECORD_ID)
    expect(await carryRecordId(record)).toBe(await skillId(record))
    const { cell, host } = await mount(serveKyber())
    const answer = await cell.execute({ action: 'carry', what: 'kyber-cpu-weights', drop: '0-9' }) as J
    expect(answer).toEqual({
      ok: true, scalars: 1329, packets: 110, dropped: 10, recovered: 1329, exact: true,
      weightsSha256: DOT_INT16_SHA256, recoveredSha256: DOT_INT16_SHA256, same: true, fuelUsed: expect.any(Number) as number,
      carrier: carryCarrierDisclosure('drop-0-9', 10),
    })
    expect(answer.fuelUsed as number).toBeLessThan(2 * PIN.fuel)
    process.stdout.write(`carry answer (0-9): ${JSON.stringify(answer)}\n`)
    const menger = await cell.execute({ action: 'carry', what: 'kyber-cpu-weights', drop: 'menger-80' }) as J
    expect(menger).toEqual({
      ok: true, scalars: 1329, packets: 110, dropped: 30, recovered: 1329, exact: true,
      weightsSha256: DOT_INT16_SHA256, recoveredSha256: DOT_INT16_SHA256, same: true, fuelUsed: expect.any(Number) as number,
      carrier: carryCarrierDisclosure('menger-80', 30),
    })
    expect((menger.carrier as J).note).toBe(CARRY_CARRIER_NOTE)
    expect(menger.fuelUsed as number).toBeLessThan(2 * PIN.fuel)
    process.stdout.write(`carry answer (menger-80): ${JSON.stringify(menger)}\n`)
    const none = await cell.execute({ action: 'carry', what: 'kyber-cpu-weights', drop: 'none' }) as J
    expect(none).toMatchObject({
      ok: true, dropped: 0, recovered: 1329, exact: true, same: true,
      carrier: carryCarrierDisclosure('all', 0),
    })
    // Two journal lines per carry (six lines across the three runs), all the pinned cell, all as x6_cell.
    const journal = await host.journal()
    expect(journal.lines.filter(line => line.cell === 'pentora-codec').map(line => [line.op, line.status, line.caller]).reverse()).toEqual([
      ['pentora.encode', 'ok', 'x6_cell'], ['pentora.decode', 'ok', 'x6_cell'],
      ['pentora.encode', 'ok', 'x6_cell'], ['pentora.decode', 'ok', 'x6_cell'],
      ['pentora.encode', 'ok', 'x6_cell'], ['pentora.decode', 'ok', 'x6_cell'],
    ])
  }, 120_000)

  it('carry refuses, closed, on anything but her pinned record and its weights; it is a compute', async () => {
    const weights = new Uint8Array(await readFile(new URL('kyber/cpu-weights.json', CELLS)))
    const changed = Uint8Array.from(weights)
    changed[200] = (changed[200] ?? 0) ^ 0x01
    const record = new Uint8Array(await readFile(new URL('kyber/skills/countdown.json', CELLS)))
    const recordChanged = Uint8Array.from(record)
    recordChanged[30] = (recordChanged[30] ?? 0) ^ 0x01
    const { cell } = await mount(serveKyber({ '/cells/kyber/cpu-weights.json': changed }))
    expect(await cell.execute({ action: 'carry', what: 'kyber-cpu-weights' })).toEqual({ ok: false, code: 'CARRY_WEIGHTS_MISMATCH' })
    expect(await cell.execute({ action: 'carry', what: 'her-mind' })).toMatchObject({ ok: false, code: 'CARRY_WHAT_UNKNOWN' })
    expect(await cell.execute({ action: 'carry', what: 'kyber-cpu-weights', drop: '3-12' })).toMatchObject({ ok: false, code: 'CARRY_DROP_UNSUPPORTED', drop: ['0-9', 'menger-80', 'none'] })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    const second = await mount(serveKyber({ '/cells/kyber/skills/countdown.json': recordChanged }))
    expect(await second.cell.execute({ action: 'carry', what: 'kyber-cpu-weights' })).toEqual({ ok: false, code: 'CARRY_RECORD_MISMATCH' })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    const third = await mount(async () => null)
    expect(await third.cell.execute({ action: 'carry', what: 'kyber-cpu-weights' })).toEqual({ ok: false, code: 'CARRY_RECORD_UNAVAILABLE' })
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'carry', what: 'kyber-cpu-weights', drop: '0-9' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'carry', what: 'kyber-cpu-weights', drop: 'menger-80' })).toBe(0)
  }, 120_000)
})
