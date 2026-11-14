/**
 * Her deterministic nucleus (apps/web/public/cells/nucleus.wat, the Kyber lab's reflex machine): the pin and the sealed
 * profile; byte-exact answers against the plain JavaScript evaluator (nucleus-reference.ts) on the lab's own reflexes
 * and on 5,000 random tables; `reflex.diff` complete against brute force and bounded on the largest domain; refusals
 * (malformed reflex, fuel exhaustion) never a wrong answer; the Touch ID tier rule as a SHADOW table against the real
 * classifyTransition on 20,000 generated manifest pairs; and a rebuild from its WAT through compileAndRun.
 * No network, no browser: Node worker_threads stand in for her browser worker, as in aura-focus-cell.spec.ts.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { CELL_MAX_MEMORY_PAGES, CELL_PINS, METERED_CELL_EXPORTS, admitCell, createCellHost, inspectWasmMemory, type CellHost, type CellWorker } from '../../src/x6/wasm-cells.ts'
import { NVA, canon, indexOf, respond, requestText, sha256Hex } from './nucleus-reference.ts'
import { NUCLEUS_TIER_OUTCOME_BITS, NUCLEUS_TIER_SIZES, nucleusTierFacts } from '../../src/x6/nucleus-tier.ts'

const CELLS = new URL('../../../../../apps/web/public/cells/', import.meta.url)
const ORIGIN = 'https://node.example.invalid'
const PIN = CELL_PINS['nucleus']!
const FUEL = 300_000_000n
type J = Record<string, unknown>

// ---------- the cell, in-process (for bulk byte-exact runs) and through her host on a worker ----------
const BYTES = readFileSync(new URL('nucleus.wasm', CELLS))
interface Direct {
  memory: WebAssembly.Memory
  mv_alloc: (n: number) => number
  mv_run: (p: number, n: number) => bigint
  __mv_fuel_set: (f: bigint) => void
  __mv_fuel_remaining: () => bigint
}
const direct = new WebAssembly.Instance(new WebAssembly.Module(BYTES), {}).exports as unknown as Direct
/** One call on the exact pinned bytes, in this thread, with her pinned fuel grant. */
function cell(text: string | Uint8Array): string {
  const request = typeof text === 'string' ? new TextEncoder().encode(text) : text
  direct.__mv_fuel_set(FUEL)
  const pointer = direct.mv_alloc(request.byteLength)
  if (pointer === 0) return 'ALLOC'
  new Uint8Array(direct.memory.buffer, pointer, request.byteLength).set(request)
  direct.__mv_fuel_set(FUEL)
  const packed = direct.mv_run(pointer, request.byteLength)
  const length = Number(packed >> 32n), offset = Number(packed & 0xffff_ffffn)
  return new TextDecoder().decode(new Uint8Array(direct.memory.buffer, offset, length))
}
const expected = (text: string): string => respond(new TextEncoder().encode(text))
/** The cell's bytes must equal the evaluator's bytes; returns the parsed answer. */
function exact(text: string): J {
  const got = cell(text)
  expect(got).toBe(expected(text))
  return JSON.parse(got) as J
}
const result = (answer: J): J => answer.result as J

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
const testHost = (fetchImpl: typeof fetch, pins?: Parameters<typeof createCellHost>[0]['pins']): CellHost => {
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

// ---------- the integer-only scan of the binary (the same walker as aura-focus-cell.spec.ts) ----------
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
/** Walk every function body and global initializer; accept only integer, control and memory opcodes. */
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
    if (id === 1) {
      let count, at; [count, at] = uleb(bytes, pos)
      for (; count > 0; count -= 1) {
        if (bytes[at++] !== 0x60) throw new Error('function type')
        for (let side = 0; side < 2; side += 1) {
          let n; [n, at] = uleb(bytes, at)
          for (; n > 0; n -= 1) if (!INTEGER_TYPES.has(bytes[at++] ?? 0)) throw new Error('non-integer value type')
        }
      }
    } else if (id === 6) {
      let count, at; [count, at] = uleb(bytes, pos)
      for (; count > 0; count -= 1) {
        if (!INTEGER_TYPES.has(bytes[at] ?? 0)) throw new Error('non-integer global')
        at = expr(at + 2, end)
      }
    } else if (id === 10) {
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

// ---------- reflexes: the lab's own, and random ones ----------
interface LabFixture {
  focusNet: J
  focusEdits: Record<string, unknown>
  tierNet: J
  tierEdits: Record<string, unknown>
}
const LAB = JSON.parse(readFileSync(new URL('fixtures/nucleus-lab-reflexes.json', import.meta.url), 'utf8')) as LabFixture
const TIER_TABLE_TEXT = readFileSync(new URL('reflexes/touch-id-tier.json', CELLS), 'utf8')
const TIER_TABLE = JSON.parse(TIER_TABLE_TEXT) as J
const TIER_DOMAIN = [3, 2, 2, 2, 2, 2, 2]
const withLayers = (base: J, layers: unknown): J => ({ ...base, layers })
/** The lab's packed form of a `net` (reference.py pack_net): every non-zero W and bias as pos*256 + (v+128). */
function packNet(net: J): J {
  const layers = (net.layers as { W: number[][]; b: number[]; shift: number }[]).map((L) => {
    const rows = L.W.length, cols = (L.W[0] ?? []).length, nz: number[] = []
    for (let i = 0; i < rows; i += 1) for (let j = 0; j <= cols; j += 1) {
      const v = j < cols ? (L.W[i]![j] ?? 0) : (L.b[i] ?? 0)
      if (v !== 0) nz.push((i * (cols + 1) + j) * 256 + v + 128)
    }
    return { cols, nz, rows, shift: L.shift }
  })
  return { ...net, kind: 'pnet', layers }
}
const diffReq = (before: J, after: J, cap = 16_384, seq = 1, domain = before.sizes): string =>
  requestText('reflex.diff', { after, before, cap, domain }, seq)

/** A seeded generator (mulberry32), so every run sees the same cases. */
interface Rng {
  int: (lo: number, hi: number) => number
  pick: <T>(items: readonly T[]) => T
  chance: (p: number) => boolean
}
function rng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1))
  return { int, pick: items => items[int(0, items.length - 1)]!, chance: p => next() < p }
}
const increasingSubset = (r: Rng, below: number, p: number): number[] =>
  Array.from({ length: below }, (_, i) => i).filter(() => r.chance(p))
function randomSizes(r: Rng, maxD: number): number[] {
  const sizes: number[] = []
  let d = 1
  for (let n = r.int(1, 5); n > 0; n -= 1) {
    const s = r.int(2, 6)
    if (d * s > maxD) break
    sizes.push(s); d *= s
  }
  return sizes.length > 0 ? sizes : [2]
}
function randomTable(r: Rng, sizes = randomSizes(r, 1296)): J {
  const d = sizes.reduce((a, b) => a * b, 1)
  const k = r.chance(0.1) ? r.int(1, 600) : r.int(1, 12)
  return { escalate: increasingSubset(r, Math.min(k, 64), 0.3), kind: 'table', outcomes: k, sizes, table: Array.from({ length: d }, () => r.int(0, k - 1)) }
}
function randomNet(r: Rng, sizes = randomSizes(r, 400)): J {
  const feed = sizes.map(s => (s === 2 && r.chance(0.5) ? 0 : 1))
  let width = 0
  feed.forEach((f, i) => { width += f === 1 ? sizes[i]! : 1 })
  const out = r.chance(0.5) ? 'onehot' : 'flags'
  const layers: J[] = []
  const depth = r.int(1, 3)
  const coarse = r.chance(0.7)
  for (let l = 0; l < depth; l += 1) {
    const rows = r.int(1, 6)
    const value = (): number => (coarse ? r.pick([-1, 0, 0, 1]) * r.pick([1, 1, 2]) : r.int(-128, 127))
    layers.push({ W: Array.from({ length: rows }, () => Array.from({ length: width }, value)),
      b: Array.from({ length: rows }, () => (coarse ? r.pick([-127, 0, 0, 127]) : r.int(-128, 127))), shift: coarse ? 0 : r.int(0, 8) })
    width = rows
  }
  const escalate = out === 'onehot' ? increasingSubset(r, width, 0.4) : { if_clear: r.int(0, 2 ** width - 1) & r.int(0, 2 ** width - 1), if_set: r.int(0, 2 ** width - 1) & r.int(0, 2 ** width - 1) }
  return { escalate, feed, kind: 'net', layers, out, sizes }
}
/** A copy of `table` with about `share` of its rows changed. */
function editTable(r: Rng, table: J, share: number): J {
  const k = table.outcomes as number
  return { ...table, table: (table.table as number[]).map(v => (r.chance(share) ? r.int(0, k - 1) : v)) }
}

// ---------- the Touch ID tier shadow: the adapter (src/x6/nucleus-tier.ts, the nucleus) and the lab's generator ----------
type Manifest = { entries: Record<string, J> } & J
interface RealTier {
  tier: string
  requiresPasskey: boolean
  t2Reasons: readonly string[]
}
interface RealTransition { classifyTransition: (p: unknown, c: unknown, o: unknown) => RealTier }
interface RealManifest { validateManifestStructure: (m: unknown) => string | null }
const TIER_BITS: readonly string[] = NUCLEUS_TIER_OUTCOME_BITS
/**
 * A manifest pair and its options -> the tier domain's case index, through her runtime's own adapter. The edge reads a
 * canonical id only when `canonicalManifestMatches === true`, so that is the one fact passed.
 */
function tierCase(prev: Manifest, cand: Manifest, opts: J): number {
  const facts = nucleusTierFacts(prev, cand, { canonicalManifestMatches: opts.canonicalManifestMatches === true })
  if (!facts.ok) throw new Error(facts.reason)
  expect(facts.row).toBe(indexOf([...facts.facts], TIER_DOMAIN))
  return facts.row
}
/** The lab's generator of manifest pairs (V1/shadow_tier.py random_items), on a seeded generator. */
function manifestPair(r: Rng, shas: string[], hex: () => string): { prev: Manifest; cand: Manifest; opts: J } {
  const IDS = ['seed-aura', 'gate-judge', 'auma-scion', 'organ-a', 'organ-b', 'organ-c', `organ-a:${'f'.repeat(64)}`,
    `seed-aura:${'e'.repeat(64)}`, `seed-aura:${'E'.repeat(64)}`, 'Seed-Aura', 'organ-d:short']
  const CONFIGS: J[] = [{}, {}, { a: 1 }, { a: 2 }, { a: 1, b: [1, 2] }, { governance: true }, { governance: false },
    { governance: 0 }, { governance: null }, { n: { x: 1, y: 2 } }, { n: { y: 2, x: 1 } }]
  const clone = <T>(value: T): T => structuredClone(value)
  const entry = (id: string): J => {
    const e: J = { config: clone(r.pick(CONFIGS)), disabled: r.chance(0.15), id, previousSpecifiers: [],
      specifier: r.pick([...shas, ...shas, ...shas].map(h => `ball:${h}`).concat(['npm:pkg', 'x'])) }
    if (r.chance(0.08)) e.governance = r.pick([true, false, null, 'x'])
    if (r.chance(0.1)) e.note = r.pick(['a', 'b'])
    return e
  }
  const mutate = (source: J): J => {
    const e = clone(source)
    const kind = r.pick(['specifier', 'specifier', 'disabled', 'config', 'governance', 'note', 'whole'])
    if (kind === 'whole') return entry(e.id as string)
    if (kind === 'specifier') e.specifier = r.pick(shas.map(h => `ball:${h}`).concat(['npm:pkg']))
    else if (kind === 'disabled') e.disabled = !e.disabled
    else if (kind === 'config') e.config = clone(r.pick(CONFIGS))
    else if (kind === 'governance') { if (Object.hasOwn(e, 'governance')) delete e.governance; else e.governance = r.pick([true, false, null]) }
    else e.note = r.pick(['a', 'b', 'c'])
    return e
  }
  const manifest = (entries: Record<string, J>, ballId: string, parent: string | null, epoch: number): Manifest => {
    const used = [...new Set([...Object.values(entries).map(e => String(e.specifier)).filter(s => s.startsWith('ball:')).map(s => s.slice(5)), r.pick(shas)])].sort()
    return { ballId, entries, epoch, modules: Object.fromEntries(used.map(h => [h, { sha256: h, specifier: `ball:${h}` }])), parentBallId: parent, version: 'x6.1-ball/v1' }
  }
  const P: Record<string, J> = {}
  const ids = [...IDS]
  for (let n = r.int(0, 4); n > 0; n -= 1) { const id = ids.splice(r.int(0, ids.length - 1), 1)[0]!; P[id] = entry(id) }
  if (r.chance(0.6)) for (const id of Object.keys(P)) if (r.chance(0.6)) { P[id]!.disabled = false; P[id]!.specifier = `ball:${r.pick(shas)}`; delete P[id]!.governance }
  const C = clone(P)
  for (let n = r.pick([0, 1, 1, 1, 1, 1, 2, 3]); n > 0; n -= 1) {
    const op = r.pick(['mod', 'mod', 'mod', 'mod', 'add', 'del'])
    const present = Object.keys(C).sort()
    if (op === 'mod' && present.length > 0) { const id = r.pick(present); C[id] = mutate(C[id]!) }
    else if (op === 'add') { const id = r.pick(IDS); C[id] = entry(id) }
    else if (op === 'del' && present.length > 0) Reflect.deleteProperty(C, r.pick(present))
  }
  const b0 = hex(), b1 = hex()
  const prev = manifest(P, b0, null, 1)
  const shuffled = Object.keys(C).sort(() => (r.chance(0.5) ? 1 : -1))
  const cand = manifest(Object.fromEntries(shuffled.map(id => [id, C[id]!])), b1, b0, 2)
  const opts = r.pick<J>([...Array<J>(5).fill({ canonicalManifestMatches: true }), { canonicalManifestMatches: false }, { canonicalManifestMatches: 'true' }, {}])
  return { prev, cand, opts }
}

describe('nucleus cell: pinned, sealed, integer-only, an instrument', () => {
  it('is pinned: exact bytes, 16 fixed pages, zero imports, the metered exports, integer opcodes only', async () => {
    const bytes = new Uint8Array(BYTES)
    expect([bytes.byteLength, createHash('sha256').update(bytes).digest('hex')]).toEqual([PIN.bytes, PIN.sha256])
    expect(PIN.ops).toEqual(['reflex.run', 'reflex.diff', 'reflex.digest', 'reflex.census'])
    expect(PIN.fuel).toBe(300_000_000)
    expect(inspectWasmMemory('nucleus', bytes, CELL_MAX_MEMORY_PAGES)).toEqual({ initial: 16, maximum: 16 })
    const module = await admitCell('nucleus', PIN, bytes)
    expect(WebAssembly.Module.imports(module)).toEqual([])
    expect(WebAssembly.Module.exports(module).map(entry => entry.name).sort()).toEqual([...METERED_CELL_EXPORTS])
    expect(integerOnlyOpcodes(bytes).size).toBeGreaterThan(20)
    const floatBody = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 10, 14, 1, 12, 0, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0x1a, 0x0b])
    expect(() => integerOnlyOpcodes(floatBody)).toThrow(/opcode 0x44/)
    const changed = Uint8Array.from(bytes)
    changed[bytes.byteLength >> 1] = (changed[bytes.byteLength >> 1] ?? 0) ^ 0x01
    await expect(admitCell('nucleus', PIN, changed)).rejects.toMatchObject({ name: 'CellError', code: 'MODULE_HASH' })
  })

  it('the shipped Touch ID tier reflex is the lab\'s table, byte for byte, and its digest names it', () => {
    expect(sha256Hex(TIER_TABLE_TEXT)).toBe('b76f54837eb4d36dfbec83d6b118f00e762dd5394ebaac25757b4303394be903')
    expect(TIER_TABLE_TEXT).toBe(`${canon(TIER_TABLE)}\n`)
    const answer = result(exact(requestText('reflex.digest', { reflex: TIER_TABLE })))
    expect(answer).toEqual({ bytes: TIER_TABLE_TEXT.length - 1, cases: 192,
      escalate: sha256Hex(canon(TIER_TABLE.escalate)), reflex: sha256Hex(canon(TIER_TABLE)) })
  })

  it('rebuilds from its WAT through compileAndRun with the pinned skillsmith, to exactly the pinned bytes', async () => {
    const wat = await readFile(new URL('nucleus.wat', CELLS), 'utf8')
    const reflex = { escalate: [1], kind: 'table', outcomes: 2, sizes: [2, 2], table: [0, 1, 1, 0] }
    const built = await testHost(served()).compileAndRun({ wat, name: 'nucleus', version: 'v1', op: 'reflex.run', input: { input: [1, 0], reflex } })
    expect(built).toMatchObject({ ok: true, meteredSha256: PIN.sha256, cellSha256: CELL_PINS['skillsmith']!.sha256,
      result: { decision: 1, escalate: 1, reflex: sha256Hex(canon(reflex)), row: 2 } })
  }, 60_000)
})

describe('nucleus cell: byte-exact against the plain JavaScript evaluator', () => {
  it('holds the lab\'s own numbers on its own reflexes (P1, the tier edit E2 in six phrasings, the v1 data rules)', () => {
    const F = LAB.focusNet, TN = LAB.tierNet, E = LAB.focusEdits, T = LAB.tierEdits
    const focus = (name: string): J => withLayers(F, E[name])
    const changed = (before: J, after: J): number => result(exact(diffReq(before, after))).changed as number
    // P1: last night's net against its edit, itself, and the checker's four edits.
    const p1 = result(exact(diffReq(F, focus('edit'))))
    expect([p1.changed, p1.unchanged, p1.escalations_removed]).toEqual([18, 1278, 0])
    expect(changed(F, F)).toBe(0)
    expect(changed(focus('edit'), focus('edit'))).toBe(0)
    expect(['checker0', 'checker1', 'checker2', 'checker3'].map(name => changed(F, focus(name)))).toEqual([162, 4, 18, 342])
    // E2, the dangerous tier edit (two numbers, each moved by one): exactly one escalation removed, however asked.
    const e2 = withLayers(TN, T['E2_dangerous_T1_ignores_config'])
    const phrasings = [diffReq(TN, e2), diffReq(TN, e2, 0, 9), diffReq(TIER_TABLE, e2),
      diffReq(TN, { ...e2, escalate: { if_clear: 0, if_set: 0 } }),
      diffReq(TN, packNet(e2)), diffReq(packNet(TN), e2)]
    for (const text of phrasings) {
      const answer = result(exact(text))
      expect([answer.escalations_removed, answer.escalations_removed_list, answer.changed]).toEqual([1, [77], 1])
    }
    expect(result(exact(phrasings[3]!)).escalate_differs).toBe(1)
    expect(result(exact(phrasings[2]!)).escalate_differs).toBe(1)
    expect(result(exact(phrasings[0]!)).escalate_differs).toBe(0)
    // The table and the hand-written net are the same reflex: an empty diff both ways.
    expect(result(exact(diffReq(TIER_TABLE, TN)))).toMatchObject({ changed: 0, unchanged: 192, invalid: 0 })
    expect(result(exact(diffReq(TN, TIER_TABLE)))).toMatchObject({ changed: 0, unchanged: 192, invalid: 0 })
    for (const name of Object.keys(T)) exact(diffReq(TN, withLayers(TN, T[name])))
    expect(result(exact(diffReq(TN, withLayers(TN, T['E3_dangerous_consistent']))))).toMatchObject({ changed: 16, escalations_removed: 1 })
    expect(result(exact(diffReq(TN, withLayers(TN, T['H1_harmless_looking_noncanon']))))).toMatchObject({ changed: 96, became_invalid_count: 96, escalations_removed: 0 })
    expect(result(exact(diffReq(TN, withLayers(TN, T['H2_truly_harmless_noentry']))))).toMatchObject({ changed: 0 })
    // The v1 data rules: every one a refusal by name.
    const refused = (text: string): string => {
      const answer = exact(text)
      expect(answer.status).toBe('refused')
      return answer.code as string
    }
    const noEscalate: J = { ...TN }
    delete noEscalate.escalate
    expect(refused(diffReq(TN, noEscalate))).toBe('MALFORMED')
    expect(refused(diffReq(TN, { ...TN, escalate: [256] }))).toBe('SHAPE')
    expect(refused(diffReq(TIER_TABLE, { ...TIER_TABLE, escalate: { if_clear: 256, if_set: 0 } }))).toBe('SHAPE')
    expect(refused(diffReq(TIER_TABLE, { ...TIER_TABLE, escalate: [512] }))).toBe('SHAPE')
    expect(refused(diffReq(F, { ...F, escalate: [0, 11] }))).toBe('SHAPE')
    expect(refused(diffReq(TN, { ...TN, escalate: { if_clear: 512, if_set: 0 } }))).toBe('SHAPE')
    expect(refused(diffReq(TN, { ...TN, escalate: { if_clear: -1, if_set: 0 } }))).toBe('MALFORMED')
    expect(refused(diffReq(TN, { ...TN, escalate: { if_clear: 32_768, if_set: 0 } }))).toBe('LIMIT')
    expect(refused(diffReq(F, { ...F, escalate: [1, 0] }))).toBe('MALFORMED')
    // A caller cannot choose what counts as an escalation: the lab's old `escalate` request key is refused.
    expect(refused(requestText('reflex.diff', { after: e2, before: TN, cap: 10, domain: TIER_DOMAIN, escalate: [] }))).toBe('MALFORMED')
  })

  it('answers reflex.run, reflex.digest and reflex.census byte for byte on 5,000 random tables and 600 random nets', () => {
    const r = rng(20_261_113)
    let runs = 0, refusedRuns = 0, escalating = 0
    for (let n = 0; n < 5600; n += 1) {
      const reflex = n < 5000 ? randomTable(r) : randomNet(r)
      const sizes = reflex.sizes as number[], d = sizes.reduce((a, b) => a * b, 1)
      const row = r.int(0, d - 1)
      const input = r.chance(0.5) ? row : sizes.map((s, i) => Math.floor(row / sizes.slice(i + 1).reduce((a, b) => a * b, 1)) % s)
      const answer = exact(requestText('reflex.run', { input, reflex }, r.int(0, 2 ** 40)))
      runs += 1
      if (answer.status === 'refused') { refusedRuns += 1; expect(answer.code).toBe('NO_VALID_ANSWER') }
      else {
        expect(result(answer).row).toBe(row)
        if (result(answer).escalate === 1) escalating += 1
      }
      exact(requestText('reflex.digest', { reflex }))
      if (n % 10 === 0) exact(requestText('reflex.census', { reflex }))
    }
    expect(runs).toBe(5600)
    expect(refusedRuns).toBeGreaterThan(0)
    expect(escalating).toBeGreaterThan(500)
  }, 120_000)

  it('refuses malformed requests by name, and never gives a wrong answer for a damaged one', () => {
    const t = TIER_TABLE
    const codes = (text: string): string => (exact(text).code as string | undefined) ?? 'ok'
    const valid = requestText('reflex.run', { input: 77, reflex: t })
    expect(codes(valid)).toBe('ok')
    expect(codes(valid.replace('"input":77', '"input":77.0'))).toBe('MALFORMED')
    expect(codes(valid.replace('"input":77', '"input":077'))).toBe('MALFORMED')
    expect(codes(valid.replace('"input":77', '"input":-0'))).toBe('MALFORMED')
    expect(codes(`${valid} `)).toBe('MALFORMED')
    expect(codes(valid.replace('reflex.run', 'reflex.ran'))).toBe('OP_UNKNOWN')
    expect(codes(valid.replace('reflex.run', 'reflex.diff'))).toBe('OP_UNKNOWN')
    expect(codes(requestText('reflex.run', { input: 192, reflex: t }))).toBe('CASE_RANGE')
    expect(codes(requestText('reflex.run', { input: [3, 0, 0, 0, 0, 0, 0], reflex: t }))).toBe('CASE_RANGE')
    expect(codes(requestText('reflex.run', { input: [0, 0, 0], reflex: t }))).toBe('CASE_RANGE')
    expect(codes(requestText('reflex.run', { input: 0, reflex: { ...t, table: (t.table as number[]).slice(1) } }))).toBe('SHAPE')
    expect(codes(requestText('reflex.run', { input: 0, reflex: { ...t, kind: 'tables' } }))).toBe('MALFORMED')
    expect(codes(requestText('reflex.run', { input: 0, reflex: { ...t, sizes: [128, 128] } }))).toBe('LIMIT')
    expect(codes(requestText('reflex.diff', { after: t, before: t, cap: 16_385, domain: TIER_DOMAIN }))).toBe('LIMIT')
    expect(codes(requestText('reflex.diff', { after: t, before: t, cap: 1, domain: [3, 2, 2, 2, 2, 2] }))).toBe('DOMAIN_MISMATCH')
    expect(codes(requestText('reflex.diff', { after: t, before: t, cap: 1, domain: [1] }))).toBe('LIMIT')
    expect(codes(requestText('reflex.diff', { after: t, before: t, cap: 1, domain: [] }))).toBe('LIMIT')
    expect(codes(requestText('reflex.diff', { after: { ...t, sizes: [2, 2, 2, 2, 2, 2, 2, 2], table: Array(256).fill(0) }, before: t, cap: 1, domain: TIER_DOMAIN }))).toBe('DOMAIN_MISMATCH')
    expect(codes(requestText('reflex.diff', { after: t, before: t, cap: 1 }))).toBe('MALFORMED')
    expect(codes(requestText('reflex.census', { input: 1, reflex: t }))).toBe('OP_UNKNOWN')
    const silent = { escalate: [], feed: [1], kind: 'net', layers: [{ W: [[0, 0]], b: [0], shift: 0 }], out: 'onehot', sizes: [2] }
    expect(codes(requestText('reflex.run', { input: 0, reflex: silent }))).toBe('NO_VALID_ANSWER')
    // One damaged byte anywhere: either a refusal, or (when the damage is still a well-formed request) exactly the evaluator's answer.
    const r = rng(7)
    const base = new TextEncoder().encode(valid)
    let refusals = 0, answers = 0
    for (let n = 0; n < 3000; n += 1) {
      const damaged = Uint8Array.from(base)
      const at = r.int(0, damaged.length - 1)
      damaged[at] = r.chance(0.5) ? r.int(0x20, 0x7e) : (damaged[at]! ^ (1 << r.int(0, 7)))
      const got = JSON.parse(cell(damaged)) as J
      const want = JSON.parse(respond(damaged)) as J
      if (got.status === 'refused') { refusals += 1; expect(want.status).toBe('refused') }
      else { answers += 1; expect(got).toEqual(want) }
    }
    expect(refusals).toBeGreaterThan(1000)
    expect(answers).toBeGreaterThan(0)
  }, 60_000)
})

describe('nucleus cell: reflex.diff lists every changed decision, bounded', () => {
  it('is complete on small domains: the listed cases equal brute force through the cell\'s own reflex.run', () => {
    const r = rng(11)
    let pairs = 0, totalChanged = 0
    for (let n = 0; n < 150; n += 1) {
      const sizes = randomSizes(r, 64)
      const before = n % 3 === 0 ? randomNet(r, sizes) : randomTable(r, sizes)
      const after = n % 3 === 1 ? randomNet(r, sizes) : n % 2 === 0 ? editTable(r, before.kind === 'table' ? before : randomTable(r, sizes), 0.2) : randomTable(r, sizes)
      const d = sizes.reduce((a, b) => a * b, 1)
      const answer = exact(diffReq(before, after, d))
      if (answer.status !== 'ok') continue
      pairs += 1
      const decision = (reflex: J, row: number): number => {
        const one = JSON.parse(cell(requestText('reflex.run', { input: row, reflex }))) as J
        if (one.status === 'ok') return result(one).decision as number
        expect(one.code).toBe('NO_VALID_ANSWER')
        return -1
      }
      const brute: number[][] = []
      for (let row = 0; row < d; row += 1) {
        const x = decision(before, row), y = decision(after, row)
        if (x !== y) brute.push([row, x, y])
      }
      const listed = result(answer)
      expect(listed.changes).toEqual(brute)
      expect([listed.changed, listed.unchanged, listed.truncated]).toEqual([brute.length, d - brute.length, 0])
      totalChanged += brute.length
    }
    expect(pairs).toBeGreaterThan(100)
    expect(totalChanged).toBeGreaterThan(500)
  }, 120_000)

  it('is bounded on the largest domain (16,384 cases): the list stops at the cap, the count, the checksum and every removed escalation stay whole', () => {
    const r = rng(12)
    const sizes = [4, 4, 4, 4, 4, 4, 4]
    const before: J = { ...randomTable(r, sizes), outcomes: 8, escalate: [0, 1] }
    before.table = (before.table as number[]).map(v => v % 8)
    const after = editTable(r, before, 0.2)
    const capped = result(exact(diffReq(before, after, 100)))
    const whole = result(exact(diffReq(before, after, 16_384)))
    expect(capped.changes).toHaveLength(100)
    expect([capped.truncated, whole.truncated]).toEqual([1, 0])
    expect(capped.changed).toBe(whole.changed)
    expect(whole.changes).toHaveLength(whole.changed as number)
    expect(capped.changes).toEqual((whole.changes as unknown[]).slice(0, 100))
    expect(capped.checksum).toBe(whole.checksum)
    expect(capped.escalations_removed_list).toEqual(whole.escalations_removed_list)
    expect((capped.escalations_removed_list as number[]).length).toBe(capped.escalations_removed)
    expect(capped.escalations_removed).toBeGreaterThan(100)
    expect(result(exact(diffReq(before, after, 0))).changes).toEqual([])
  }, 60_000)
})

describe('nucleus cell: through her own host, refusals are never a wrong answer', () => {
  it('answers on a separate worker; a malformed reflex, a reflex with no answer and fuel exhaustion come back as refusals', async () => {
    const cells = testHost(served())
    const run = await cells.invoke('nucleus', 'reflex.run', { input: [1, 0, 0, 1, 1, 1, 1], reflex: TIER_TABLE })
    expect(run).toMatchObject({ ok: true, sha256: PIN.sha256, result: { decision: 256, escalate: 0, row: 79 } })
    expect(run.ok && run.fuelUsed > 0 && run.fuelUsed < PIN.fuel).toBe(true)
    // The short op name resolves to the one op it names.
    expect(await cells.invoke('nucleus', 'digest', { reflex: TIER_TABLE })).toMatchObject({ ok: true, result: { cases: 192 } })
    expect(await cells.invoke('nucleus', 'reflex.run', { input: 0, reflex: { ...TIER_TABLE, outcomes: 'many' } })).toMatchObject({ ok: false, code: 'MALFORMED' })
    expect(await cells.invoke('nucleus', 'reflex.run', { input: 0, reflex: { escalate: [], feed: [1], kind: 'net', layers: [{ W: [[0, 0]], b: [0], shift: 0 }], out: 'onehot', sizes: [2] } }))
      .toMatchObject({ ok: false, code: 'NO_VALID_ANSWER' })
    // Starved of fuel: a refusal, and the next call with her real grant still answers.
    const starved = await testHost(served(), { nucleus: { ...PIN, fuel: 5000 } }).invoke('nucleus', 'reflex.run', { input: 0, reflex: TIER_TABLE })
    expect(starved).toMatchObject({ ok: false, code: 'FUEL' })
    // A diff too large for her grant (two dense 4,016-weight nets on 16,384 cases): FUEL, never a partial answer.
    const dense = (seed: number): J => ({ escalate: { if_clear: 0, if_set: 0 }, feed: Array<number>(14).fill(0), kind: 'net', out: 'flags', sizes: Array<number>(14).fill(2),
      layers: [{ W: Array.from({ length: 64 }, () => Array<number>(14).fill(seed)), b: Array<number>(64).fill(0), shift: 0 },
        { W: Array.from({ length: 48 }, () => Array<number>(64).fill(1)), b: Array<number>(48).fill(0), shift: 4 },
        { W: [Array<number>(48).fill(1)], b: [-127], shift: 0 }] })
    expect(await cells.invoke('nucleus', 'reflex.diff', { after: dense(2), before: dense(1), cap: 10, domain: Array<number>(14).fill(2) }))
      .toMatchObject({ ok: false, code: 'FUEL' })
    expect(await cells.invoke('nucleus', 'reflex.run', { input: 79, reflex: TIER_TABLE })).toMatchObject({ ok: true, result: { decision: 256 } })
  }, 60_000)
})

describe('nucleus cell: the Touch ID tier rule as a SHADOW reflex (nothing in her authority path reads it)', () => {
  it('decides exactly as the real classifyTransition on 20,000 generated manifest pairs that pass the real validator', async () => {
    const transition = await import(new URL('../../../../../server/ball-transition.mjs', import.meta.url).href) as unknown as RealTransition
    const manifests = await import(new URL('../../../../../server/ball-manifest.mjs', import.meta.url).href) as unknown as RealManifest
    const r = rng(20_261_112)
    const hexChar = (): string => '0123456789abcdef'[r.int(0, 15)]!
    const hex = (): string => Array.from({ length: 64 }, hexChar).join('')
    const shas = Array.from({ length: 6 }, hex)
    expect([...NUCLEUS_TIER_SIZES]).toEqual(TIER_DOMAIN)
    // Every case of the table, through her host on a worker, equals the in-process cell (the bulk below runs in-process).
    const cells = testHost(served())
    for (let row = 0; row < 192; row += 1) {
      const hosted = await cells.invoke('nucleus', 'reflex.run', { input: row, reflex: TIER_TABLE })
      expect(hosted.ok && hosted.result).toEqual(result(JSON.parse(cell(requestText('reflex.run', { input: row, reflex: TIER_TABLE }))) as J))
    }
    let compared = 0, rejected = 0, t1 = 0
    const reached = new Set<number>()
    while (compared < 20_000) {
      const { prev, cand, opts } = manifestPair(r, shas, hex)
      if (manifests.validateManifestStructure(prev) !== null || manifests.validateManifestStructure(cand) !== null) {
        rejected += 1
        continue
      }
      const real = transition.classifyTransition(prev, cand, opts)
      const realBits = real.t2Reasons.reduce((bits, reason) => bits | (1 << TIER_BITS.indexOf(reason)), real.tier === 'T1' ? 256 : 0)
      expect(real.t2Reasons.every(reason => TIER_BITS.includes(reason))).toBe(true)
      const row = tierCase(prev, cand, opts)
      const answer = JSON.parse(cell(requestText('reflex.run', { input: row, reflex: TIER_TABLE }))) as J
      expect(answer.status).toBe('ok')
      const decision = result(answer)
      expect([decision.decision, decision.escalate], `pair ${String(compared)}: ${JSON.stringify(real.t2Reasons)}`).toEqual([realBits, real.requiresPasskey ? 1 : 0])
      if (!real.requiresPasskey) t1 += 1
      reached.add(row)
      compared += 1
    }
    expect(compared).toBe(20_000)
    expect(rejected).toBe(0)
    expect(t1).toBeGreaterThan(100)
    // Every case a real manifest pair can reach was reached: 2 (no change) + 2 (several) + 36 (one organ: protected and
    // canonical either way, then either missing or the 8 combinations of the three per-organ facts) = 40 of the 192.
    const reachable = Array.from({ length: 192 }, (_, row) => row).filter((row) => {
      const count = Math.floor(row / 64), missing = (row >> 4) & 1
      const moduleOk = (row >> 3) & 1, disabledClean = (row >> 2) & 1, configSame = (row >> 1) & 1
      if (count !== 1) return ((row >> 1) & 31) === 0
      return missing === 0 || (moduleOk === 0 && disabledClean === 0 && configSame === 0)
    })
    expect(reachable).toHaveLength(40)
    expect([...reached].sort((a, b) => a - b)).toEqual(reachable)
    expect(NVA).toBe(65_535)
  }, 180_000)
})
