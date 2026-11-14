/**
 * One run, two hosts (`x6_cell` action `handoff`). A program on the weight CPU cell is started HERE, in her
 * browser, cut at step `cutAt`, and finished on the EDGE (POST /_host/cell-run, the Worker running the same pinned bytes
 * as its second host) from the checkpoint written at that cut. The two ends are compared byte for byte.
 *
 * In order, one call each, nothing retried:
 *   (a) the whole program here (`cpu.run`): the reference end;
 *   (b) the same program here again with checkpoints (`cpu.run` with `checkpointEvery`, the cell's own way: the
 *       checkpoint whose `stepsTaken` is `cutAt`; stride `cutAt`, or the cell's largest stride for a cut at step 0);
 *   (c) that checkpoint to the edge as `cpu.resume`;
 *   (d) `same`: the canonical JSON of the two ends, compared byte for byte; `null` when the edge gave no end.
 * Both local calls are journalled as any cell call (caller `x6_cell`); the edge's call is one line more, caller `edge`,
 * with the pin the edge answered with, or `unanswered` (`noteEdgeCall`).
 *
 * Nothing here is authority. It reads nothing of hers and writes nothing anywhere; the edge takes nothing from the
 * checkpoint but the machine state, and a checkpoint's `check` is a checksum, not a permission. What it shows: the same
 * pinned bytes on two hosts give the same end from a cut. What it does not: a second browser, another engine family,
 * or a move of HER.
 * @module x6/cell-handoff
 */
import { CELL_PINS, cellCanonicalJson, type CellHost, type CellPin } from './wasm-cells.ts'

/** The edge's cell route (the Worker's one route for it). */
export const CELL_RUN_PATH = '/_host/cell-run'
/** The edge's answer is read up to this many bytes. */
export const HANDOFF_ANSWER_MAX_BYTES = 64 * 1024
/** One edge call, one deadline; nothing is retried. */
export const HANDOFF_EDGE_TIMEOUT_MS = 15_000
/** The cell's own bound on `steps` and on `checkpointEvery` (the machine has 4,096 states). */
const STEPS_MAX = 4096
const RUN = 'cpu.run'
const RESUME = 'cpu.resume'
const CODE = /^[A-Z0-9_]{1,80}$/u
const SHA = /^[a-f0-9]{64}$/u
const ARGS = new Set(['action', 'cell', 'input', 'cutAt'])

export interface HandoffDeps {
  /** Her page's origin (the edge is same-origin). */
  readonly origin: string | undefined
  readonly fetchImpl?: typeof fetch
  /** The clock for the edge line's `ms` (tests pass a fixed one). */
  readonly now?: () => number
}

export interface HandoffAnswer {
  readonly ok: boolean
  /** Present when `ok` is false: a closed code (the local cell's, this module's, or the edge's own). */
  readonly code?: string
  readonly cell: string
  readonly cutAt: number | null
  /** The end of the uninterrupted run here: `{ halted, state, stepsTaken }`. */
  readonly local: unknown
  /** The end the edge reached from the checkpoint, or null when it gave none. */
  readonly edge: unknown
  readonly same: boolean | null
  readonly pins: { readonly browser: string | null; readonly edge: string | null }
  /** SHA-256 of the checkpoint's canonical JSON, exactly what was sent. */
  readonly checkpointSha256: string | null
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const sha256 = async (bytes: Uint8Array): Promise<string> => hex(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))

/** The kyber-cpu cell is handed off only when its pin names both ops; the edge decides for itself which cells it runs. */
function handoffPin(name: unknown): CellPin | null {
  if (name !== 'kyber-cpu' || !Object.hasOwn(CELL_PINS, 'kyber-cpu')) return null
  const pin = CELL_PINS['kyber-cpu']
  return pin?.ops?.includes(RUN) === true && pin.ops.includes(RESUME) ? pin : null
}

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > HANDOFF_ANSWER_MAX_BYTES) { await reader.cancel().catch(() => undefined); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * Run `x6_cell { action: "handoff", cell, input: { rom, state, steps }, cutAt }`.
 * @param cells - her cell host (the local runs and the journal).
 * @param args - the tool's arguments, exactly those four keys.
 * @param deps - her origin and fetch.
 * @returns the comparison, or a closed refusal; never throws for an edge that is down or refuses.
 */
export async function cellHandoff(cells: CellHost, args: Record<string, unknown>, deps: HandoffDeps): Promise<HandoffAnswer> {
  const cell = typeof args.cell === 'string' ? args.cell : ''
  const cutAt = Number.isSafeInteger(args.cutAt) ? args.cutAt as number : null
  const refused = (code: string, more: Partial<HandoffAnswer> = {}): HandoffAnswer => ({
    ok: false, code, cell, cutAt, local: null, edge: null, same: null, pins: { browser: null, edge: null }, checkpointSha256: null,
    ...more })
  if (Object.keys(args).some(key => !ARGS.has(key))) return refused('HANDOFF_INPUT_INVALID')
  const pin = handoffPin(args.cell)
  if (pin === null) return refused('HANDOFF_CELL_REFUSED')
  const input = args.input
  if (!record(input) || Object.keys(input).length !== 3 || !['rom', 'state', 'steps'].every(key => Object.hasOwn(input, key))) {
    return refused('HANDOFF_INPUT_INVALID')
  }
  if (cutAt === null || cutAt < 0 || cutAt > STEPS_MAX) return refused('HANDOFF_CUT_INVALID')
  if (!deps.origin || deps.origin === 'null') return refused('HANDOFF_ORIGIN_UNAVAILABLE')
  const run = { rom: input.rom, state: input.state, steps: input.steps }

  // (a) The reference: the whole program, here.
  const whole = await cells.invoke(cell, RUN, run, 'x6_cell')
  if (!whole.ok) return refused(whole.code, { pins: { browser: whole.sha256, edge: null } })
  const local = whole.result
  const browser = whole.sha256
  const length = record(local) && Number.isSafeInteger(local.stepsTaken) ? local.stepsTaken as number : null
  if (length === null) return refused('HANDOFF_LOCAL_INVALID', { local, pins: { browser, edge: null } })
  if (cutAt > length) return refused('HANDOFF_CUT_OUT_OF_RANGE', { local, pins: { browser, edge: null } })

  // (b) The same program again, here, for the checkpoint the cell writes at the cut.
  const marked = await cells.invoke(cell, RUN, { ...run, checkpointEvery: cutAt === 0 ? STEPS_MAX : cutAt }, 'x6_cell')
  if (!marked.ok) return refused(marked.code, { local, pins: { browser, edge: null } })
  const checkpoints = record(marked.result) && Array.isArray(marked.result.checkpoints) ? marked.result.checkpoints : []
  const checkpoint: unknown = checkpoints.find(entry => record(entry) && entry.stepsTaken === cutAt)
  if (!record(checkpoint)) return refused('HANDOFF_CHECKPOINT_MISSING', { local, pins: { browser, edge: null } })
  const checkpointSha256 = await sha256(new TextEncoder().encode(cellCanonicalJson(checkpoint)))

  // (c) The edge resumes it. One request, one deadline.
  const body = new TextEncoder().encode(cellCanonicalJson({ cell, input: { checkpoint }, op: RESUME }))
  const now = deps.now ?? (() => globalThis.performance.now())
  const started = now()
  let text: string | null = null
  let answer: unknown = null
  let code: string | null = null
  let response: Response | null = null
  try {
    response = await (deps.fetchImpl ?? globalThis.fetch)(new URL(CELL_RUN_PATH, deps.origin).href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'same-origin',
      signal: AbortSignal.timeout(HANDOFF_EDGE_TIMEOUT_MS),
    })
  } catch {
    code = 'EDGE_UNREACHABLE'
  }
  if (response !== null) {
    try {
      text = await readCapped(response)
      if (text === null) code = 'EDGE_ANSWER_TOO_LARGE'
      else answer = JSON.parse(text)
    } catch { code = 'EDGE_ANSWER_INVALID' }
    if (code === null && !record(answer)) code = 'EDGE_ANSWER_INVALID'
    else if (code === null && record(answer) && answer.ok !== true) {
      code = typeof answer.code === 'string' && CODE.test(answer.code) ? answer.code : 'EDGE_REFUSED'
    } else if (code === null && record(answer)
      && (typeof answer.pin !== 'string' || !SHA.test(answer.pin) || !Object.hasOwn(answer, 'result'))) {
      code = 'EDGE_ANSWER_INVALID'
    }
  }
  const edgePin = record(answer) && typeof answer.pin === 'string' && SHA.test(answer.pin) ? answer.pin : null
  const fuelUsed = record(answer) && Number.isSafeInteger(answer.fuelUsed) ? answer.fuelUsed as number : null
  cells.noteEdgeCall({ cell, op: RESUME, pin: edgePin ?? 'unanswered', request: body, answer: text, code, fuelUsed, ms: now() - started })
  if (code !== null || !record(answer)) {
    return refused(code ?? 'EDGE_ANSWER_INVALID', { local, pins: { browser, edge: edgePin }, checkpointSha256 })
  }

  // (d) The two ends, byte for byte.
  let edgeText: string
  try { edgeText = cellCanonicalJson(answer.result) } catch {
    return refused('EDGE_ANSWER_INVALID', { local, pins: { browser, edge: edgePin }, checkpointSha256 })
  }
  const same = cellCanonicalJson(local) === edgeText
  return { ok: true, cell, cutAt, local, edge: answer.result, same, pins: { browser, edge: edgePin }, checkpointSha256 }
}
