/**
 * One ongoing Cord skill, `x6_cell` action `cord`. The pinned cell `cord-echo`
 * owns the logical tick and the typed inputs; its checkpoint (`aukora.cord.checkpoint.v1`) binds the cell, the skill, the
 * profile, the parent, the tick, the state and the per-tick input and output roots into one head. She can run each leg
 * HERE (her browser's cell host) or at her EDGE (POST /_host/cell-run, the same pinned bytes), and continue from either.
 *
 * Where freshness is decided: by the head SHE holds (Kira's shelf: `/dsh/home/cord/<skillId>/head.json`), never by a
 * checkpoint. A checkpoint carries digests anyone can compute, so it is evidence of a run, never permission
 * (docs/capsule/CONTRACT.md 6.6 and 7.1: a checkpoint cannot declare itself current). A leg commits only when every
 * check below holds against what she read under her lock and against her own independent TypeScript oracle; any failed
 * check writes nothing under /dsh/home/cord/.
 *
 * The edge has no memory: its `expect` comes from her request, so its CORD_HEAD_STALE catches a request assembled from
 * the wrong checkpoint; it is NOT an independent head. The commit here is where staleness is decided.
 *
 * Each leg leaves one evidence record (`aukora.cord-evidence.v1`, Aura's name) naming each claim KNOWN, UNOBSERVABLE or
 * FAILED and by what. It is kept in session memory (the last 32) and in the cell journal lines; it is not signed, not
 * stored, not a receipt, not in the capsule record. Nothing here holds an owner key, touches the ledger, HEAD, MIRROR or
 * the lease, or grants anything.
 * @module x6/cord-run
 */
import { CELL_PINS, cellCanonicalJson, type CellHost } from './wasm-cells.ts'
import { parseCanonical, verifySkill } from './skill-record.ts'

export const CORD_CELL = 'cord-echo'
export const CORD_PROFILE = 'fifo24'
export const CORD_FIELD = 65_521
export const CORD_WORDS = 24
export const CORD_MAX_INPUTS = 1000
export const CORD_MAX_TICK = 2_147_483_647
export const CORD_CHECKPOINT_SCHEMA = 'aukora.cord.checkpoint.v1'
export const CORD_EVIDENCE_SCHEMA = 'aukora.cord-evidence.v1'
export const CORD_STATE_SCHEMA = 'aukora.cord.fifo24.v1'
/** Kira's shelf: one folder per skill id. */
export const CORD_DIR = '/dsh/home/cord'
/** The profile's retention promise (apps/web/public/cells/cord/fifo24.profile.json `retention.keep`). */
export const CORD_KEEP = 8
/** Evidence records held in session memory. */
export const CORD_EVIDENCE_MAX = 32
/** One edge call, one deadline; nothing is retried. */
export const CORD_EDGE_TIMEOUT_MS = 15_000
export const CORD_EDGE_PATH = '/_host/cell-run'
export const CORD_PROFILE_PATH = '/cells/cord/fifo24.profile.json'
export const CORD_SKILL_INDEX_PATH = '/cells/kyber/skills/index.json'
export const CORD_SKILL_NAME = 'cord-echo'
/**
 * The `skill` every checkpoint inside the shipped record's cases names: SHA-256(UTF-8 "aukora.cord.case-skill.v1").
 * A record cannot contain its own id (its cases hold checkpoints, and a checkpoint names the skill), so the cases use this
 * fixed value. The cell binds `skill` into the head and never judges it; the HOST requires a live checkpoint's `skill`
 * to equal the kept record's id (CORD_SKILL_MISMATCH).
 */
export const CORD_CASE_SKILL = '89f9cd4e2073cf5042bf7d93d4426f62f12065bd5f387e1424b6fd4ffaf6774c'
const ZERO = '0'.repeat(64)
const HEX = /^[0-9a-f]{64}$/u
const CODE = /^[A-Z0-9_]{1,80}$/u
const ANSWER_MAX_BYTES = 64 * 1024
const FETCH_TIMEOUT_MS = 10_000
const SHIPPED_FILE = /^kyber\/skills\/[a-z0-9.-]{1,64}\.json$/u

export interface CordCheckpoint {
  readonly cell: string
  readonly head: string
  readonly inputRoot: string
  readonly outputRoot: string
  readonly parent: string
  readonly profile: string
  readonly profileSha256: string
  readonly schema: typeof CORD_CHECKPOINT_SCHEMA
  readonly skill: string
  readonly state: readonly number[]
  readonly stateSha256: string
  readonly tick: number
}

export type CordClaimName = 'parent-is-my-head' | 'head-recomputed' | 'state-is-my-last-24-inputs' | 'outputs-match-my-oracle'
  | 'pin-equal' | 'bytes-that-ran-at-the-edge' | 'edge-fuel'
export interface CordClaim { readonly claim: CordClaimName; readonly status: 'KNOWN' | 'UNOBSERVABLE' | 'FAILED'; readonly by: string }
export interface CordEvidence {
  readonly schema: typeof CORD_EVIDENCE_SCHEMA
  /** null only when the feed named no valid place (CORD_AT_INVALID): no leg ran. */
  readonly at: 'here' | 'edge' | null
  readonly skill: string | null
  readonly profile: string
  readonly parent: string | null
  readonly head: string | null
  readonly tick: number | null
  readonly inputs: number
  readonly inputRoot: string | null
  readonly outputRoot: string | null
  readonly stateSha256: string | null
  readonly pins: { readonly here: string | null; readonly edge: string | null }
  readonly fuelUsed: number | null
  readonly code: string | null
  readonly claims: readonly CordClaim[]
}

// ---------------------------------------------------------------- pure digests and the oracle (WebCrypto only)

const encoder = new TextEncoder()
const hexOf = (bytes: ArrayBuffer | Uint8Array): string =>
  [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../gu) ?? [], pair => Number.parseInt(pair, 16))
const sha = async (bytes: Uint8Array): Promise<string> => hexOf(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value).sort()
  return own.length === keys.length && [...keys].sort().every((key, index) => key === own[index])
}
const isWord = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < CORD_FIELD

/** SHA-256 of UTF-8 text, lowercase hex. */
export const cordTextSha256 = (text: string): Promise<string> => sha(encoder.encode(text))

/** stateSha256: the 24 words as u16 little-endian, s[0] first (48 bytes). */
export function cordStateSha256(state: readonly number[]): Promise<string> {
  const bytes = new Uint8Array(state.length * 2)
  state.forEach((word, index) => { bytes[2 * index] = word & 255; bytes[2 * index + 1] = word >>> 8 })
  return sha(bytes)
}

/** The head over the fixed 248-byte layout: domain, cell, skill, profileSha256, parent, u32le(tick), stateSha256, roots. */
export function cordHead(fields: Pick<CordCheckpoint, 'cell' | 'skill' | 'profileSha256' | 'parent' | 'tick' | 'stateSha256' | 'inputRoot' | 'outputRoot'>): Promise<string> {
  const out = new Uint8Array(248)
  out.set(encoder.encode('aukora.cord.head.v1\n'), 0)
  let at = 20
  for (const hex of [fields.cell, fields.skill, fields.profileSha256, fields.parent]) { out.set(bytesOf(hex), at); at += 32 }
  new DataView(out.buffer).setUint32(at, fields.tick, true)
  at += 4
  for (const hex of [fields.stateSha256, fields.inputRoot, fields.outputRoot]) { out.set(bytesOf(hex), at); at += 32 }
  return sha(out)
}

/** The per-tick root chain from `root` after tick `from`: SHA-256(root || u32le(t) || u16le(v)) for t = from+1, from+2, .. */
export async function cordChain(root: string, from: number, values: readonly number[]): Promise<string> {
  let current = bytesOf(root)
  for (const [index, value] of values.entries()) {
    const message = new Uint8Array(38)
    message.set(current, 0)
    const view = new DataView(message.buffer)
    view.setUint32(32, from + index + 1, true)
    view.setUint16(36, value, true)
    current = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', message))
  }
  return hexOf(current)
}

/** The independent fifo24 oracle: the window after the inputs and the outputs of this segment only (no prefix replay). */
export function cordFifoOracle(state: readonly number[], inputs: readonly number[]): { state: number[]; outputs: number[] } {
  const window = [...state]
  const outputs: number[] = []
  for (const value of inputs) {
    window.unshift(value)
    window.length = CORD_WORDS
    outputs.push(((3 * (window[7] ?? 0) - 2 * (window[15] ?? 0) + (window[23] ?? 0)) % CORD_FIELD + CORD_FIELD) % CORD_FIELD)
  }
  return { state: window, outputs }
}

/** The genesis checkpoint, computed here (the cell computes the same; the shipped record's cases hold the two equal). */
export async function cordGenesis(cell: string, skill: string, profileSha256: string): Promise<CordCheckpoint> {
  const state = new Array<number>(CORD_WORDS).fill(0)
  const fields = { cell, skill, profileSha256, parent: ZERO, tick: 0, stateSha256: await cordStateSha256(state),
    inputRoot: await cordTextSha256('aukora.cord.inputs.v1'), outputRoot: await cordTextSha256('aukora.cord.outputs.v1') }
  return { ...fields, head: await cordHead(fields), profile: CORD_PROFILE, schema: CORD_CHECKPOINT_SCHEMA, state }
}

/** What `cord.run` must answer for a checkpoint and a segment, computed here independently of the cell. */
export async function cordRunOracle(checkpoint: CordCheckpoint, inputs: readonly number[]):
Promise<{ checkpoint: CordCheckpoint; outputs: number[] }> {
  const { state, outputs } = cordFifoOracle(checkpoint.state, inputs)
  const fields = { cell: checkpoint.cell, skill: checkpoint.skill, profileSha256: checkpoint.profileSha256, parent: checkpoint.head,
    tick: checkpoint.tick + inputs.length, stateSha256: await cordStateSha256(state),
    inputRoot: await cordChain(checkpoint.inputRoot, checkpoint.tick, inputs),
    outputRoot: await cordChain(checkpoint.outputRoot, checkpoint.tick, outputs) }
  const head = await cordHead(fields)
  const next: CordCheckpoint = { ...fields, head, profile: checkpoint.profile, schema: CORD_CHECKPOINT_SCHEMA, state }
  return { checkpoint: next, outputs }
}

/** The checkpoint's exact shape (every key, hex fields 64 lowercase, 24 words in the field, tick in range), or a problem. */
export function cordCheckpointProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'not an object'
  if (!exactKeys(value, ['cell', 'head', 'inputRoot', 'outputRoot', 'parent', 'profile', 'profileSha256', 'schema', 'skill', 'state', 'stateSha256', 'tick'])) return 'keys'
  for (const key of ['cell', 'head', 'inputRoot', 'outputRoot', 'parent', 'profileSha256', 'skill', 'stateSha256']) {
    if (typeof value[key] !== 'string' || !HEX.test(value[key])) return key
  }
  if (value.schema !== CORD_CHECKPOINT_SCHEMA) return 'schema'
  if (typeof value.profile !== 'string') return 'profile'
  if (!Array.isArray(value.state) || value.state.length !== CORD_WORDS || !value.state.every(isWord)) return 'state'
  if (typeof value.tick !== 'number' || !Number.isSafeInteger(value.tick) || value.tick < 0 || value.tick > CORD_MAX_TICK) return 'tick'
  return null
}

/** Both digests of a checkpoint recompute (WebCrypto). */
async function digestsHold(checkpoint: CordCheckpoint): Promise<{ state: boolean; head: boolean }> {
  return { state: await cordStateSha256(checkpoint.state) === checkpoint.stateSha256, head: await cordHead(checkpoint) === checkpoint.head }
}

// ---------------------------------------------------------------- the shelf she holds

/** The VFS calls this module makes (her MemoryVfs). */
export interface CordVfs {
  existsSync(path: string): boolean
  readFileSync(path: string): string | Uint8Array
  writeFileSync(path: string, data: string | Uint8Array): void
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown
  readdirSync(path: string): unknown
  unlinkSync(path: string): void
}
export interface CordLocks { request<T>(name: string, work: () => Promise<T>): Promise<T> }
export interface CordDeps {
  readonly vfs: CordVfs
  readonly cells: () => CellHost
  /** Her page's origin (the edge and the shipped files are same-origin). */
  readonly origin: string | undefined
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  /** Web Locks (navigator.locks by default; one realm's own chain when absent). */
  readonly locks?: CordLocks
  /** The edge deadline (CORD_EDGE_TIMEOUT_MS; tests pass a short one). */
  readonly edgeTimeoutMs?: number
}

const chains = new Map<string, Promise<unknown>>()
/** One realm's fallback lock: calls under one name run one after another. */
const realmLocks: CordLocks = {
  request<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(name) ?? Promise.resolve()
    const next = previous.then(work, work)
    chains.set(name, next.catch(() => undefined))
    return next
  },
}
const defaultLocks = (): CordLocks => {
  const locks = (globalThis as { navigator?: { locks?: CordLocks } }).navigator?.locks
  return locks && typeof locks.request === 'function' ? locks : realmLocks
}

const dirOf = (skill: string): string => `${CORD_DIR}/${skill}`
const headPathOf = (skill: string): string => `${dirOf(skill)}/head.json`
const checkpointPathOf = (skill: string, head: string): string => `${dirOf(skill)}/checkpoints/${head}.json`

interface StoredHead { readonly head: string; readonly tick: number; readonly generation: number }
type Stored = { readonly kind: 'none' } | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'ok'; readonly stored: StoredHead; readonly checkpoint: CordCheckpoint }

const textOf = (value: string | Uint8Array): string => typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value)

function readStoredHead(vfs: CordVfs, skill: string): StoredHead | 'none' | 'invalid' {
  const path = headPathOf(skill)
  if (!vfs.existsSync(path)) return 'none'
  try {
    const value = parseCanonical(encoder.encode(textOf(vfs.readFileSync(path))))
    if (!isRecord(value) || !exactKeys(value, ['generation', 'head', 'tick'])) return 'invalid'
    const { generation, head, tick } = value
    if (typeof head !== 'string' || !HEX.test(head) || typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0
      || tick > CORD_MAX_TICK || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return 'invalid'
    return { head, tick, generation }
  } catch { return 'invalid' }
}

/** Read a kept checkpoint by its head, re-hashed: it must be named by its own head and both digests must recompute. */
async function readCheckpointFile(vfs: CordVfs, skill: string, head: string): Promise<CordCheckpoint | null> {
  try {
    const value = parseCanonical(encoder.encode(textOf(vfs.readFileSync(checkpointPathOf(skill, head)))))
    if (cordCheckpointProblem(value) !== null) return null
    const checkpoint = value as CordCheckpoint
    if (checkpoint.head !== head) return null
    const digests = await digestsHold(checkpoint)
    return digests.state && digests.head ? checkpoint : null
  } catch { return null }
}

/** head.json and the checkpoint it names, FRESH, every check by name. */
async function readStored(vfs: CordVfs, skill: string): Promise<Stored> {
  const stored = readStoredHead(vfs, skill)
  if (stored === 'none') return { kind: 'none' }
  if (stored === 'invalid') return { kind: 'invalid', detail: 'head.json' }
  const checkpoint = await readCheckpointFile(vfs, skill, stored.head)
  if (checkpoint === null) return { kind: 'invalid', detail: 'checkpoint' }
  if (checkpoint.tick !== stored.tick) return { kind: 'invalid', detail: 'tick' }
  return { kind: 'ok', stored, checkpoint }
}

function keptHeads(vfs: CordVfs, skill: string): string[] {
  try {
    const names = vfs.readdirSync(`${dirOf(skill)}/checkpoints`)
    return Array.isArray(names) ? names.map(String).flatMap(name => /^([0-9a-f]{64})\.json$/u.exec(name)?.[1] ?? []).sort() : []
  } catch { return [] }
}

/** Keep the CORD_KEEP newest checkpoints by tick; the current head and its parent are never pruned. */
function prune(vfs: CordVfs, skill: string, head: string, parent: string): number {
  const rows: Array<{ head: string; tick: number }> = []
  for (const kept of keptHeads(vfs, skill)) {
    let tick = -1
    try {
      const value = JSON.parse(textOf(vfs.readFileSync(checkpointPathOf(skill, kept)))) as unknown
      if (isRecord(value) && typeof value.tick === 'number') tick = value.tick
    } catch { tick = -1 }
    rows.push({ head: kept, tick })
  }
  rows.sort((a, b) => b.tick - a.tick || (a.head < b.head ? -1 : 1))
  const keep = new Set([head, parent])
  for (const row of rows) { if (keep.size >= CORD_KEEP) break; keep.add(row.head) }
  let removed = 0
  for (const row of rows) {
    if (keep.has(row.head)) continue
    const prunedPath = checkpointPathOf(skill, row.head)
    vfs.unlinkSync(prunedPath)
    removed += 1
  }
  return removed
}

// ---------------------------------------------------------------- the shipped skill record

interface SkillFacts { readonly id: string; readonly profileSha256: string }
/** The shipped record, its program, its id from the index, and the profile file, as fetched. */
export type CordShippedFiles = () => Promise<{ record: Uint8Array; program: Uint8Array; id: string; profile: Uint8Array }>

async function fetchBytes(deps: CordDeps, path: string, max: number): Promise<Uint8Array> {
  if (!deps.origin || deps.origin === 'null') throw new Error('CORD_ORIGIN_UNAVAILABLE')
  const response = await (deps.fetchImpl ?? globalThis.fetch)(new URL(path, deps.origin).href, { method: 'GET', credentials: 'same-origin',
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error('CORD_SKILL_UNAVAILABLE')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > max) throw new Error('CORD_SKILL_UNAVAILABLE')
  return bytes
}

/** The shipped cord-echo record, verified against the bytes her cell host admitted; and the profile file's digest. */
async function loadSkill(deps: CordDeps, files: CordShippedFiles): Promise<SkillFacts | { code: string }> {
  let shipped
  try { shipped = await files() } catch { return { code: 'CORD_SKILL_UNAVAILABLE' } }
  const cell = await deps.cells().verifiedBytes(CORD_CELL)
  if (cell === null) return { code: 'CORD_CELL_UNAVAILABLE' }
  const verdict = await verifySkill(shipped.record, { cell, program: shipped.program }, shipped.id)
  if (!verdict.ok) return { code: verdict.code }
  const { record, program } = verdict
  const pin = CELL_PINS[CORD_CELL]
  if (record.cell.kind !== 'pinned' || record.cell.name !== CORD_CELL || record.cell.sha256 !== pin?.sha256 || record.op !== 'cord.run'
    || record.state.schema !== CORD_STATE_SCHEMA || !exactKeys(program, ['profile']) || program.profile !== CORD_PROFILE) return { code: 'CORD_SKILL_MISMATCH' }
  return { id: verdict.id, profileSha256: await sha(shipped.profile) }
}

// ---------------------------------------------------------------- one leg

const claim = (name: CordClaimName, status: CordClaim['status'], by: string): CordClaim => ({ claim: name, status, by })

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > ANSWER_MAX_BYTES) { await reader.cancel().catch(() => undefined); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

type RunAnswer = { ok: true; result: unknown; pin: string | null; edgePin: string | null; fuelUsed: number | null }
  | { ok: false; code: string; pin: string | null; edgePin: string | null; fuelUsed: number | null }

/** The edge leg: one POST, one deadline, nothing retried, one journal line (caller `edge`). */
async function runAtEdge(deps: CordDeps, cells: CellHost, input: Record<string, unknown>): Promise<RunAnswer> {
  const body = encoder.encode(cellCanonicalJson({ cell: CORD_CELL, input, op: 'cord.run' }))
  const now = deps.now ?? (() => globalThis.performance.now())
  const started = now()
  let text: string | null = null, answer: unknown = null, code: string | null = null
  const deadline = deps.edgeTimeoutMs ?? CORD_EDGE_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve('late') }, deadline) })
  try {
    if (!deps.origin || deps.origin === 'null') throw new Error('origin')
    const response = await Promise.race([(deps.fetchImpl ?? globalThis.fetch)(new URL(CORD_EDGE_PATH, deps.origin).href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, credentials: 'same-origin', signal: controller.signal }), late])
    if (response === 'late') code = 'EDGE_UNREACHABLE'
    else {
      try {
        const read = await Promise.race([readCapped(response), late])
        if (read === 'late') code = 'EDGE_UNREACHABLE'
        else if (read === null) code = 'EDGE_ANSWER_TOO_LARGE'
        else { text = read; answer = JSON.parse(read) }
      } catch { code = 'EDGE_ANSWER_INVALID' }
    }
  } catch { code = 'EDGE_UNREACHABLE' }
  finally { clearTimeout(timer) }
  if (code === null && !isRecord(answer)) code = 'EDGE_ANSWER_INVALID'
  const edgePin = isRecord(answer) && typeof answer.pin === 'string' && HEX.test(answer.pin) ? answer.pin : null
  const fuelUsed = isRecord(answer) && Number.isSafeInteger(answer.fuelUsed) ? answer.fuelUsed as number : null
  if (code === null && isRecord(answer) && answer.ok !== true) code = typeof answer.code === 'string' && CODE.test(answer.code) ? answer.code : 'EDGE_REFUSED'
  if (code === null && isRecord(answer) && (edgePin === null || !Object.hasOwn(answer, 'result'))) code = 'EDGE_ANSWER_INVALID'
  cells.noteEdgeCall({ cell: CORD_CELL, op: 'cord.run', pin: edgePin ?? 'unanswered', request: body, answer: text, code, fuelUsed, ms: now() - started })
  if (code !== null || !isRecord(answer)) return { ok: false, code: code ?? 'EDGE_ANSWER_INVALID', pin: null, edgePin, fuelUsed }
  return { ok: true, result: answer.result, pin: null, edgePin, fuelUsed }
}

/** The only keys an `x6_cell cord` call may carry. */
const CORD_ARG_KEYS: readonly string[] = ['action', 'step', 'inputs', 'at']

/** The shelf over one session. The last 32 evidence records live here, in memory only. */
export function createCordShelf(deps: CordDeps, shippedFiles?: CordShippedFiles) {
  const evidence: CordEvidence[] = []
  const locks = deps.locks ?? defaultLocks()
  let cachedFiles: ReturnType<CordShippedFiles> | null = null
  const files = shippedFiles ?? (() => {
    cachedFiles ??= (async () => {
      const index = parseCanonical(await fetchBytes(deps, CORD_SKILL_INDEX_PATH, 16 * 1024))
      const entry = isRecord(index) && Array.isArray(index.skills)
        ? (index.skills as unknown[]).find(row => isRecord(row) && row.name === CORD_SKILL_NAME) : undefined
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.record !== 'string' || typeof entry.program !== 'string'
        || !SHIPPED_FILE.test(entry.record) || !SHIPPED_FILE.test(entry.program)) {
        throw new Error('CORD_SKILL_UNAVAILABLE')
      }
      return { id: entry.id, record: await fetchBytes(deps, `/cells/${entry.record}`, 64 * 1024),
        program: await fetchBytes(deps, `/cells/${entry.program}`, 16 * 1024), profile: await fetchBytes(deps, CORD_PROFILE_PATH, 16 * 1024) }
    })()
    const pending = cachedFiles
    pending.catch(() => { if (cachedFiles === pending) cachedFiles = null })
    return pending
  })
  const note = (record: CordEvidence): CordEvidence => {
    evidence.push(record)
    if (evidence.length > CORD_EVIDENCE_MAX) evidence.splice(0, evidence.length - CORD_EVIDENCE_MAX)
    return record
  }
  const pinOf = (): string | null => CELL_PINS[CORD_CELL]?.sha256 ?? null

  const start = async (): Promise<Record<string, unknown>> => {
    const skill = await loadSkill(deps, files)
    if ('code' in skill) return { ok: false, code: skill.code }
    return await locks.request(`aukora-cord-${skill.id}`, async () => {
      const found = await readStored(deps.vfs, skill.id)
      if (found.kind === 'ok') return { ok: false, code: 'CORD_ALREADY_STARTED', head: found.stored.head, tick: found.stored.tick }
      if (found.kind === 'invalid' || deps.vfs.existsSync(headPathOf(skill.id))) return { ok: false, code: 'CORD_STORE_INVALID', detail: found.kind === 'invalid' ? found.detail : 'head.json' }
      const pin = pinOf()
      if (pin === null) return { ok: false, code: 'CORD_CELL_UNAVAILABLE' }
      const answer = await deps.cells().invoke(CORD_CELL, 'cord.genesis', { cell: pin, profile: CORD_PROFILE, skill: skill.id }, 'x6_cell')
      if (!answer.ok) return { ok: false, code: answer.code }
      const expected = await cordGenesis(pin, skill.id, skill.profileSha256)
      const got = isRecord(answer.result) ? answer.result.checkpoint : null
      if (!isRecord(answer.result) || !exactKeys(answer.result, ['checkpoint']) || cellCanonicalJson(got) !== cellCanonicalJson(expected)) {
        return { ok: false, code: 'CORD_GENESIS_MISMATCH' }
      }
      deps.vfs.mkdirSync(`${dirOf(skill.id)}/checkpoints`, { recursive: true })
      const checkpointPath = checkpointPathOf(skill.id, expected.head)
      deps.vfs.writeFileSync(checkpointPath, cellCanonicalJson(expected))
      const headPath = headPathOf(skill.id)
      deps.vfs.writeFileSync(headPath, cellCanonicalJson({ generation: 1, head: expected.head, tick: 0 }))
      return { ok: true, skill: skill.id, head: expected.head, tick: 0 }
    })
  }

  const feed = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    // One evidence record per feed, refused or not: a refusal of the call's own shape is recorded too (nothing ran).
    const placed = args.at === 'edge' ? 'edge' : args.at === 'here' ? 'here' : null
    const inputs = args.inputs
    const shaped = Array.isArray(inputs) && inputs.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    const blank = (code: string, more: Partial<CordEvidence> = {}): CordEvidence => ({
      schema: CORD_EVIDENCE_SCHEMA, at: placed, skill: null, profile: CORD_PROFILE, parent: null, head: null, tick: null,
      inputs: Array.isArray(inputs) ? inputs.length : 0, inputRoot: null, outputRoot: null, stateSha256: null,
      pins: { here: null, edge: null }, fuelUsed: null, code, claims: unobservedClaims(placed, 'no answer to check'), ...more })
    const refused = (code: string, record: CordEvidence, next?: string): Record<string, unknown> =>
      ({ ok: false, code, at: placed, ...(next === undefined ? {} : { next }), evidence: note(record) })
    if (Object.keys(args).some(key => !CORD_ARG_KEYS.includes(key))) {
      return refused('CORD_ARGS_INVALID', blank('CORD_ARGS_INVALID'), 'feed takes action, step, inputs and at only')
    }
    if (placed === null) return refused('CORD_AT_INVALID', blank('CORD_AT_INVALID'), 'at is "here" or "edge"')
    if (!shaped) return refused('CORD_INPUTS_INVALID', blank('CORD_INPUTS_INVALID'), 'inputs is a list of 1 to 1,000 integers 0..65520')
    const at = placed
    const values = inputs as number[]
    const skill = await loadSkill(deps, files)
    if ('code' in skill) return refused(skill.code, blank(skill.code))

    // 1. Under her lock: head.json and its checkpoint, FRESH; the file's head recomputed, its pin and skill hers.
    const lockName = `aukora-cord-${skill.id}`
    const pin = pinOf()
    const read = await locks.request(lockName, () => readStored(deps.vfs, skill.id))
    if (read.kind === 'none') return refused('CORD_NOT_STARTED', blank('CORD_NOT_STARTED', { skill: skill.id }))
    if (read.kind === 'invalid') return refused('CORD_STORE_INVALID', blank('CORD_STORE_INVALID', { skill: skill.id }))
    const { stored, checkpoint } = read
    if (pin === null || checkpoint.cell !== pin) return refused('CORD_PIN_MISMATCH', blank('CORD_PIN_MISMATCH', { skill: skill.id, parent: stored.head }))
    if (checkpoint.skill !== skill.id) return refused('CORD_SKILL_MISMATCH', blank('CORD_SKILL_MISMATCH', { skill: skill.id, parent: stored.head }))
    const input = { checkpoint, expect: { head: stored.head, tick: stored.tick }, inputs: values, profile: CORD_PROFILE }

    // 2. Run once, here or at the edge.
    const cells = deps.cells()
    let run: RunAnswer
    if (at === 'here') {
      const answer = await cells.invoke(CORD_CELL, 'cord.run', input, 'x6_cell')
      run = answer.ok ? { ok: true, result: answer.result, pin: answer.sha256, edgePin: null, fuelUsed: answer.fuelUsed }
        : { ok: false, code: answer.code, pin: answer.sha256, edgePin: null, fuelUsed: answer.fuelUsed }
    } else run = await runAtEdge(deps, cells, input)
    const pins = { here: at === 'here' ? run.pin : pin, edge: run.edgePin }
    const base = { skill: skill.id, parent: stored.head, pins, fuelUsed: run.fuelUsed }
    if (!run.ok) return refused(run.code, blank(run.code, base))

    // 3. Every check, against what she read and her own oracle.
    const result = run.result
    const answered = isRecord(result) && exactKeys(result, ['checkpoint', 'outputs']) ? result : null
    const next = answered && cordCheckpointProblem(answered.checkpoint) === null ? answered.checkpoint as CordCheckpoint : null
    const outputs = answered && Array.isArray(answered.outputs) && answered.outputs.every(isWord) ? answered.outputs : null
    if (next === null || outputs === null) return refused('CORD_ANSWER_INVALID', blank('CORD_ANSWER_INVALID', base))
    const oracle = cordFifoOracle(checkpoint.state, values)
    const digests = await digestsHold(next)
    const inputRoot = await cordChain(checkpoint.inputRoot, checkpoint.tick, values)
    const outputRoot = await cordChain(checkpoint.outputRoot, checkpoint.tick, oracle.outputs)
    const parentOk = next.parent === stored.head
    const stateOk = cellCanonicalJson(next.state) === cellCanonicalJson(oracle.state)
    const outputsOk = cellCanonicalJson(outputs) === cellCanonicalJson(oracle.outputs) && next.outputRoot === outputRoot
    const pinOk = next.cell === pin && (at === 'here' ? run.pin === pin : run.edgePin === pin)
    const claims: CordClaim[] = [
      claim('parent-is-my-head', parentOk ? 'KNOWN' : 'FAILED', 'her store, head.json read under her lock'),
      claim('head-recomputed', digests.head && digests.state ? 'KNOWN' : 'FAILED', 'WebCrypto, here'),
      claim('state-is-my-last-24-inputs', stateOk ? 'KNOWN' : 'FAILED', 'the TypeScript oracle, here'),
      claim('outputs-match-my-oracle', outputsOk ? 'KNOWN' : 'FAILED', 'the TypeScript oracle over this segment only'),
      claim('pin-equal', pinOk ? 'KNOWN' : 'FAILED', at === 'edge' ? 'what the edge SAID its pin is' : 'her cell host admitted these bytes against CELL_PINS'),
      ...unobservedClaims(at, null).slice(5),
    ]
    const record = (code: string | null): CordEvidence => ({ schema: CORD_EVIDENCE_SCHEMA, at, skill: skill.id, profile: CORD_PROFILE,
      parent: stored.head, head: code === null ? next.head : null, tick: next.tick, inputs: values.length, inputRoot: next.inputRoot,
      outputRoot: next.outputRoot, stateSha256: next.stateSha256, pins, fuelUsed: run.fuelUsed, code, claims })
    const failure = !parentOk ? 'CORD_PARENT_STALE'
      : next.tick !== stored.tick + values.length ? 'CORD_TICK_MISMATCH'
        : next.profile !== checkpoint.profile || next.profileSha256 !== checkpoint.profileSha256 || next.profileSha256 !== skill.profileSha256 ? 'CORD_PROFILE_MISMATCH'
          : !pinOk ? 'CORD_PIN_MISMATCH'
            : next.skill !== skill.id ? 'CORD_SKILL_MISMATCH'
              : !digests.state ? 'CORD_STATE_DIGEST'
                : !digests.head ? 'CORD_HEAD_DIGEST'
                  : next.inputRoot !== inputRoot ? 'CORD_INPUT_ROOT_MISMATCH'
                    : !stateOk ? 'CORD_STATE_MISMATCH'
                      : !outputsOk ? 'CORD_OUTPUTS_MISMATCH' : null
    if (failure !== null) return refused(failure, record(failure))

    // 4. Under her lock again: head.json must still be what step 1 read; then the checkpoint, then head.json, then prune.
    const commit = (): Record<string, unknown> => {
      const again = readStoredHead(deps.vfs, skill.id)
      if (typeof again !== 'object' || again.head !== stored.head || again.tick !== stored.tick || again.generation !== stored.generation) {
        return refused('CORD_HEAD_MOVED', record('CORD_HEAD_MOVED'))
      }
      const checkpointPath = checkpointPathOf(skill.id, next.head)
      deps.vfs.writeFileSync(checkpointPath, cellCanonicalJson(next))
      const headPath = headPathOf(skill.id)
      deps.vfs.writeFileSync(headPath, cellCanonicalJson({ generation: stored.generation + 1, head: next.head, tick: next.tick }))
      prune(deps.vfs, skill.id, next.head, stored.head)
      return { ok: true, at, tick: next.tick, head: next.head, parent: stored.head, outputs, evidence: note(record(null)) }
    }
    return await locks.request(lockName, () => Promise.resolve(commit()))
  }

  const status = async (): Promise<Record<string, unknown>> => {
    const skill = await loadSkill(deps, files)
    if ('code' in skill) return { ok: false, code: skill.code }
    const stored = readStoredHead(deps.vfs, skill.id)
    const last = evidence.at(-1) ?? null
    const retention = { keep: CORD_KEEP, neverPruned: ['head', 'parent'], forgets: 'every input older than 24 ticks',
      recomputable: 'every output from a kept checkpoint forward, given its inputs', currentOutputFromState: true }
    if (stored === 'invalid') return { ok: false, code: 'CORD_STORE_INVALID', skill: skill.id, retention, lastEvidence: last }
    return { ok: true, skill: skill.id, started: stored !== 'none', head: stored === 'none' ? null : stored.head,
      tick: stored === 'none' ? null : stored.tick, generation: stored === 'none' ? null : stored.generation,
      kept: keptHeads(deps.vfs, skill.id).length, retention, evidenceCount: evidence.length, lastEvidence: last }
  }

  return {
    /** `{ action: "cord", step: "start" | "feed" | "status", inputs?, at? }`. */
    async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (args.step === 'feed') return await feed(args)
      if (Object.keys(args).some(key => !CORD_ARG_KEYS.includes(key))) return { ok: false, code: 'CORD_ARGS_INVALID' }
      if (args.step === 'start') return await start()
      if (args.step === 'status') return await status()
      return { ok: false, code: 'CORD_STEP_INVALID', next: 'step is "start", "feed" or "status"' }
    },
    /** The session's evidence records, oldest first (a copy). */
    evidence: (): CordEvidence[] => [...evidence],
  }
}

/** The closed claim list with nothing yet observed; the last two are always UNOBSERVABLE. */
function unobservedClaims(at: 'here' | 'edge' | null, why: string | null): CordClaim[] {
  const none = why ?? 'not observed'
  return [
    claim('parent-is-my-head', 'UNOBSERVABLE', none),
    claim('head-recomputed', 'UNOBSERVABLE', none),
    claim('state-is-my-last-24-inputs', 'UNOBSERVABLE', none),
    claim('outputs-match-my-oracle', 'UNOBSERVABLE', none),
    claim('pin-equal', 'UNOBSERVABLE', none),
    claim('bytes-that-ran-at-the-edge', 'UNOBSERVABLE', at === 'edge'
      ? 'a different program giving the same answer cannot be told apart from it; only the build-time pin test speaks to the bundle'
      : at === null ? 'no leg ran' : 'this leg did not run at the edge'),
    claim('edge-fuel', 'UNOBSERVABLE', at === 'edge' ? 'the edge\'s own report' : at === null ? 'no leg ran' : 'this leg did not run at the edge'),
  ]
}
