/**
 * The nucleus cell's plain JavaScript evaluator: given request bytes, the exact answer bytes the cell must give.
 * A port of the Kyber lab's locked oracle (lab/R-reflex-machine/V1/reference.py, FORMAT-V1.md), changed only where
 * apps/web/public/cells/nucleus.wat changes the lab's words: `reflex.run` takes `{ input, reflex }` and answers
 * `{ decision, escalate, reflex, row }`; `reflex.diff` (the lab's `reflex.atlas`) takes `{ after, before, cap, domain }`
 * and names the two digests `after`/`before`; `reflex.census` takes `{ reflex }`; `reflex.digest` is new.
 * It shares no code with the cell, and none with wasm-cells.ts. Integers only; refusal codes are predicted for
 * requests with one fault (as the lab's oracle).
 */
import { createHash } from 'node:crypto'

export const NVA = 65535
const MAX_REQ = 262_144
const MAX_VARS = 16, MIN_SIZE = 2, MAX_SIZE = 64, MAX_D = 16_384
const MAX_LAYERS = 8, MAX_ROWS = 64, MAX_COLS = 64, MAX_W = 4096, MAX_SHIFT = 15
const MAX_ONEHOT = 64, MAX_FLAGS = 15, MAX_K = 32_768, MAX_CAP = 16_384, MAX_ESC = 32_768

type Json = number | string | Json[] | { [key: string]: Json }
type Esc = { form: 'list'; set: Set<number>; top: number } | { form: 'masks'; ifClear: number; ifSet: number }
interface Layer { W: number[][]; b: number[]; shift: number; rows: number; cols: number }
type Reflex = { kind: 'table'; sizes: number[]; D: number; table: number[]; esc: Esc }
  | { kind: 'net'; sizes: number[]; D: number; feed: number[]; layers: Layer[]; out: 'onehot' | 'flags'; esc: Esc }

class Refuse extends Error {
  constructor(readonly code: string, readonly withSeq: boolean, readonly seq = 0) { super(code) }
}

const utf8 = new TextEncoder()
const compareKeys = (a: string, b: string): number => {
  const x = utf8.encode(a), y = utf8.encode(b)
  for (let index = 0; index < Math.min(x.length, y.length); index += 1) if (x[index] !== y[index]) return (x[index] ?? 0) - (y[index] ?? 0)
  return x.length - y.length
}

/** The lab's canonical JSON: safe integers, strings, arrays and objects with keys sorted by UTF-8 bytes; anything else throws. */
export function canon(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('not an integer')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort(compareKeys).map(key => `${JSON.stringify(key)}:${canon(record[key])}`).join(',')}}`
  }
  throw new Error('not admitted')
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
const isRecord = (value: unknown): value is Record<string, Json> => value !== null && typeof value === 'object' && !Array.isArray(value)
function need(condition: boolean, code = 'MALFORMED'): asserts condition {
  if (!condition) throw new Refuse(code, false)
}
const keys = (value: unknown, names: string[]): void => {
  need(isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort()))
}
const intList = (value: unknown): number[] => {
  need(Array.isArray(value) && value.every(isInt))
  return value
}

function readSizes(value: unknown): number {
  const sizes = intList(value)
  need(sizes.length >= 1 && sizes.length <= MAX_VARS, 'LIMIT')
  need(sizes.every(size => size >= MIN_SIZE && size <= MAX_SIZE), 'LIMIT')
  const d = sizes.reduce((product, size) => product * size, 1)
  need(d <= MAX_D, 'LIMIT')
  return d
}

function readEsc(value: unknown): Esc {
  if (Array.isArray(value)) {
    const list = intList(value)
    need(list.length <= MAX_ESC, 'LIMIT')
    list.forEach((code, index) => {
      need(code >= 0)
      need(code <= 32_767, 'LIMIT')
      need(index === 0 || (list[index - 1] ?? -1) < code)
    })
    return { form: 'list', set: new Set(list), top: list.length > 0 ? (list[list.length - 1] ?? 0) + 1 : 0 }
  }
  keys(value, ['if_clear', 'if_set'])
  const masks = value as Record<string, unknown>
  for (const key of ['if_clear', 'if_set']) {
    need(isInt(masks[key]) && masks[key] >= 0)
    need(masks[key] <= 32_767, 'LIMIT')
  }
  return { form: 'masks', ifClear: masks.if_clear as number, ifSet: masks.if_set as number }
}

/** Is outcome `code` (never NVA) an escalation under `esc`? */
export function isEscalation(esc: Esc, code: number): boolean {
  if (esc.form === 'list') return esc.set.has(code)
  return (code & esc.ifSet) !== 0 || (code & esc.ifClear) !== esc.ifClear
}

function readReflex(value: unknown, shape: string[]): Reflex {
  need(isRecord(value) && Object.hasOwn(value, 'kind') && Object.hasOwn(value, 'escalate'))
  const r = value as Record<string, unknown>
  const esc = readEsc(r.escalate)
  if (r.kind === 'table') {
    keys(r, ['escalate', 'kind', 'outcomes', 'sizes', 'table'])
    need(isInt(r.outcomes))
    const k = r.outcomes
    need(k >= 1 && k <= MAX_K, 'LIMIT')
    const d = readSizes(r.sizes)
    const table = intList(r.table)
    need(table.length <= MAX_D, 'LIMIT')
    if (table.length !== d || table.some(entry => entry < 0 || entry >= k)) shape.push('SHAPE')
    if (esc.form !== 'list' || esc.top > k) shape.push('SHAPE')
    return { kind: 'table', sizes: r.sizes as number[], D: d, table, esc }
  }
  if (r.kind !== 'net' && r.kind !== 'pnet') throw new Refuse('MALFORMED', false)
  keys(r, ['escalate', 'feed', 'kind', 'layers', 'out', 'sizes'])
  const feed = intList(r.feed)
  need(feed.every(f => f === 0 || f === 1))
  need(Array.isArray(r.layers) && r.layers.length >= 1)
  need((r.layers as unknown[]).length <= MAX_LAYERS, 'LIMIT')
  const layers: Layer[] = []
  let totalW = 0
  for (const raw of r.layers as unknown[]) {
    if (r.kind === 'net') {
      keys(raw, ['W', 'b', 'shift'])
      const L = raw as Record<string, unknown>
      need(Array.isArray(L.W) && L.W.length >= 1)
      need((L.W as unknown[]).length <= MAX_ROWS, 'LIMIT')
      const W: number[][] = []
      for (const row of L.W as unknown[]) {
        const values = intList(row)
        need(values.length >= 1)
        need(values.length <= MAX_COLS, 'LIMIT')
        need(values.every(w => w >= -128 && w <= 127))
        W.push([...values])
      }
      const rows = W.length, cols = (W[0] ?? []).length
      totalW += rows * cols
      need(totalW <= MAX_W, 'LIMIT')
      if (W.some(row => row.length !== cols)) shape.push('SHAPE')
      const b = intList(L.b)
      need(b.length <= MAX_ROWS, 'LIMIT')
      need(b.every(v => v >= -128 && v <= 127))
      if (b.length !== rows) shape.push('SHAPE')
      need(isInt(L.shift))
      need(L.shift >= 0 && L.shift <= MAX_SHIFT, 'LIMIT')
      layers.push({ W, b: [...b], shift: L.shift, rows, cols })
    } else {
      keys(raw, ['cols', 'nz', 'rows', 'shift'])
      const L = raw as Record<string, unknown>
      need(isInt(L.cols))
      const cols = L.cols
      need(cols >= 1 && cols <= MAX_COLS, 'LIMIT')
      const nz = intList(L.nz)
      let prev = -1
      const cells = new Map<number, number>()
      for (const entry of nz) {
        need(entry >= 0)
        const pos = Math.floor(entry / 256), v = (entry % 256) - 128
        need(v !== 0 && pos > prev)
        prev = pos
        need(Math.floor(pos / (cols + 1)) < MAX_ROWS, 'LIMIT')
        cells.set(pos, v)
      }
      need(isInt(L.rows))
      const rows = L.rows
      need(rows >= 1 && rows <= MAX_ROWS, 'LIMIT')
      totalW += rows * cols
      need(totalW <= MAX_W, 'LIMIT')
      need(isInt(L.shift))
      need(L.shift >= 0 && L.shift <= MAX_SHIFT, 'LIMIT')
      if (prev >= rows * (cols + 1)) shape.push('SHAPE')
      const W = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => cells.get(i * (cols + 1) + j) ?? 0))
      const b = Array.from({ length: rows }, (_, i) => cells.get(i * (cols + 1) + cols) ?? 0)
      layers.push({ W, b, shift: L.shift, rows, cols })
    }
  }
  need(r.out === 'onehot' || r.out === 'flags')
  const d = readSizes(r.sizes)
  const sizes = r.sizes as number[]
  const outRows = (layers[layers.length - 1] as Layer).rows
  need(outRows <= (r.out === 'onehot' ? MAX_ONEHOT : MAX_FLAGS), 'LIMIT')
  let width = 0
  feed.forEach((f, i) => { width += f === 1 ? (sizes[i] ?? 0) : 1 })
  const feedOk = feed.length === sizes.length && feed.every((f, i) => f === 1 || sizes[i] === 2)
  if (!feedOk || width !== (layers[0] as Layer).cols) shape.push('SHAPE')
  for (let index = 1; index < layers.length; index += 1) {
    if ((layers[index] as Layer).cols !== (layers[index - 1] as Layer).rows) shape.push('SHAPE')
  }
  if (r.out === 'onehot') { if (esc.form !== 'list' || esc.top > outRows) shape.push('SHAPE') }
  else if (esc.form !== 'masks' || (esc.ifClear | esc.ifSet) >= 2 ** outRows) shape.push('SHAPE')
  return { kind: 'net', sizes, D: d, feed, layers, out: r.out, esc }
}

/** The mixed-radix values of case `index` (variable 0 most significant). */
export function valuesOf(index: number, sizes: readonly number[]): number[] {
  const values: number[] = []
  for (let i = sizes.length - 1; i >= 0; i -= 1) {
    const size = sizes[i] as number
    values.unshift(index % size)
    index = Math.floor(index / size)
  }
  return values
}
export const indexOf = (values: readonly number[], sizes: readonly number[]): number =>
  values.reduce((index, value, i) => index * (sizes[i] as number) + value, 0)

function outcome(reflex: Reflex, index: number): number {
  if (reflex.kind === 'table') return reflex.table[index] as number
  const values = valuesOf(index, reflex.sizes)
  let x: number[] = []
  reflex.feed.forEach((f, i) => {
    const v = values[i] as number
    if (f === 0) x.push(v === 1 ? 127 : 0)
    else for (let j = 0; j < (reflex.sizes[i] as number); j += 1) x.push(j === v ? 127 : 0)
  })
  for (const L of reflex.layers) {
    x = L.W.map((row, r) => {
      let acc = L.b[r] as number
      row.forEach((w, c) => { acc += w * (x[c] as number) })
      return Math.max(0, Math.min(127, acc >> L.shift))
    })
  }
  if (reflex.out === 'onehot') {
    return x.filter(v => v === 127).length === 1 && x.filter(v => v === 0).length === x.length - 1 ? x.indexOf(127) : NVA
  }
  if (!x.every(v => v === 0 || v === 127)) return NVA
  let code = 0
  x.forEach((v, j) => { if (v === 127) code += 2 ** j })
  return code
}

/** Every case's outcome, in order. */
export const outcomesOf = (reflex: Reflex): number[] => Array.from({ length: reflex.D }, (_, index) => outcome(reflex, index))
const show = (code: number): number => (code === NVA ? -1 : code)

function census(reflex: Reflex): Record<string, Json> {
  const outs = outcomesOf(reflex)
  const counts = new Map<number, number>()
  for (const o of outs) if (o !== NVA) counts.set(o, (counts.get(o) ?? 0) + 1)
  const listed = [...counts.keys()].sort((a, b) => a - b).map(k => [k, counts.get(k) as number])
  return { cases: reflex.D, census: listed, invalid: outs.filter(o => o === NVA).length }
}

function diff(before: Reflex, after: Reflex, cap: number): Record<string, Json> {
  const a = outcomesOf(before), b = outcomesOf(after), esc = before.esc
  const removed: number[] = [], became: number[] = [], changed: [number, number, number][] = []
  let invalid = 0
  a.forEach((x, i) => {
    const y = b[i] as number
    if ((x === NVA || isEscalation(esc, x)) && y !== NVA && !isEscalation(esc, y)) removed.push(i)
    if (x !== NVA && y === NVA) became.push(i)
    if (x !== y) changed.push([i, x, y])
    if (x === NVA || y === NVA) invalid += 1
  })
  const blob = new Uint8Array(changed.length * 8)
  const view = new DataView(blob.buffer)
  changed.forEach(([i, x, y], n) => { view.setUint32(n * 8, i); view.setUint16(n * 8 + 4, x); view.setUint16(n * 8 + 6, y) })
  return {
    became_invalid: became, became_invalid_count: became.length, cases: before.D, changed: changed.length,
    changes: changed.slice(0, cap).map(([i, x, y]) => [i, show(x), show(y)]), checksum: sha256Hex(blob),
    escalations_removed: removed.length, escalations_removed_list: removed, invalid,
    truncated: changed.length > cap ? 1 : 0, unchanged: a.length - changed.length,
  }
}

const OPS: Record<string, 'run' | 'one' | 'diff'> = { 'reflex.run': 'run', 'reflex.census': 'one', 'reflex.digest': 'one', 'reflex.diff': 'diff' }

function answer(request: Uint8Array): string {
  need(request.byteLength <= MAX_REQ)
  let obj: unknown
  let good = false
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request))
    good = Buffer.compare(Buffer.from(utf8.encode(canon(obj))), Buffer.from(request)) === 0
  } catch { good = false }
  need(good)
  keys(obj, ['abi', 'input', 'op', 'seq'])
  const envelope = obj as Record<string, Json>
  need(envelope.abi === 1)
  need(isInt(envelope.seq) && envelope.seq >= 0)
  const input = envelope.input
  need(isRecord(input))
  const shape: string[] = []
  const names = JSON.stringify(Object.keys(input).sort())
  let form: 'run' | 'one' | 'diff'
  let one: Reflex | undefined, before: Reflex | undefined, after: Reflex | undefined
  if (names === '["after","before","cap","domain"]') {
    form = 'diff'
    after = readReflex(input.after, shape)
    before = readReflex(input.before, shape)
    need(isInt(input.cap))
    need(input.cap >= 0 && input.cap <= MAX_CAP, 'LIMIT')
    readSizes(input.domain)
  } else if (names === '["input","reflex"]') {
    form = 'run'
    const c = input.input
    need(isInt(c) || (Array.isArray(c) && c.every(isInt)))
    need(!Array.isArray(c) || c.length <= MAX_VARS, 'LIMIT')
    one = readReflex(input.reflex, shape)
  } else if (names === '["reflex"]') {
    form = 'one'
    one = readReflex(input.reflex, shape)
  } else throw new Refuse('MALFORMED', false)
  const op = envelope.op
  need(typeof op === 'string')
  if (!Object.hasOwn(OPS, op)) throw new Refuse('OP_UNKNOWN', false)
  const seq = envelope.seq
  const after_ = (code: string): never => { throw new Refuse(code, true, seq) }
  if (OPS[op] !== form) after_('OP_UNKNOWN')
  if (shape.length > 0) after_('SHAPE')
  let result: Record<string, Json>
  if (form === 'diff') {
    const b = before as Reflex, a = after as Reflex
    if (canon(b.sizes) !== canon(input.domain)) after_('DOMAIN_MISMATCH')
    if (canon(b.sizes) !== canon(a.sizes)) after_('DOMAIN_MISMATCH')
    const beforeRaw = input.before as Record<string, Json>, afterRaw = input.after as Record<string, Json>
    result = {
      ...diff(b, a, input.cap as number),
      after: sha256Hex(canon(afterRaw)), before: sha256Hex(canon(beforeRaw)),
      escalate: sha256Hex(canon(beforeRaw.escalate)),
      escalate_differs: canon(beforeRaw.escalate) === canon(afterRaw.escalate) ? 0 : 1,
    }
  } else {
    const reflex = one as Reflex
    const raw = input.reflex as Record<string, Json>
    const digest = sha256Hex(canon(raw))
    if (op === 'reflex.census') result = { ...census(reflex), reflex: digest }
    else if (op === 'reflex.digest') {
      result = { bytes: utf8.encode(canon(raw)).byteLength, cases: reflex.D, escalate: sha256Hex(canon(raw.escalate)), reflex: digest }
    } else {
      const c = input.input as number | number[]
      let row: number
      if (Array.isArray(c)) {
        if (c.length !== reflex.sizes.length || c.some((v, i) => v < 0 || v >= (reflex.sizes[i] as number))) after_('CASE_RANGE')
        row = indexOf(c, reflex.sizes)
      } else {
        if (c < 0 || c >= reflex.D) after_('CASE_RANGE')
        row = c
      }
      const k = outcome(reflex, row)
      if (k === NVA) after_('NO_VALID_ANSWER')
      result = { decision: k, escalate: isEscalation(reflex.esc, k) ? 1 : 0, reflex: digest, row }
    }
  }
  return canon({ abi: 1, result, seq, status: 'ok' })
}

/** The exact answer text the nucleus cell must give for these request bytes. */
export function respond(request: Uint8Array): string {
  try {
    return answer(request)
  } catch (error) {
    if (!(error instanceof Refuse)) throw error
    return canon(error.withSeq ? { abi: 1, code: error.code, seq: error.seq, status: 'refused' } : { abi: 1, code: error.code, status: 'refused' })
  }
}

/** A canonical request text. */
export const requestText = (op: string, input: unknown, seq = 1): string => canon({ abi: 1, input, op, seq })
