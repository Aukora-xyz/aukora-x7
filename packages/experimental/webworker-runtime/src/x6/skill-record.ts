/**
 * `aukora.skill.v1`: a skill she can keep. One small canonical
 * record that names exactly what a skill is: the cell that runs it (a pinned cell by the sha256 of its bytes, or a cell
 * she forged by the sha256 of its admitted bytes and of its kept WAT), the op it calls, the program it runs (by digest),
 * the weights that define the machine (by digest, with their scalar count, or null), the schema of its state, and the
 * evidence (cases in the cell's own op format, and the oracle that produced them). Its id is its digest. A record
 * describes and can be checked again; it grants nothing, it is not a receipt, and nothing in her authority path reads it.
 *
 * Pure: no I/O, no clock. The record's bytes are the cell ABI's canonical JSON (`cellCanonicalJson`, wasm-cells.ts: keys
 * sorted by UTF-8 bytes, integers only), so a skill stands on the same canonical form as the cells that run it. The id is
 * the lowercase hex SHA-256 of the UTF-8 bytes of `"aukora.skill.v1\n"` followed by the canonical record bytes. The
 * artifacts (cell, program, weights, a forged cell's WAT) keep their own identity: the plain sha256 of their exact bytes.
 * @module x6/skill-record
 */
import { cellCanonicalJson } from './wasm-cells.ts'

export const SKILL_SCHEMA = 'aukora.skill.v1'
/** The id domain: sha256(utf8(SKILL_ID_DOMAIN) || canonical record bytes). */
export const SKILL_ID_DOMAIN = 'aukora.skill.v1\n'
/** A record larger than this is refused before it is parsed (was 64 KiB). */
export const SKILL_MAX_RECORD_BYTES = 256 * 1024
/** Evidence cases one record may carry. */
export const SKILL_MAX_CASES = 64
/** A program is a small canonical JSON object. */
export const SKILL_MAX_PROGRAM_BYTES = 16 * 1024
/** A skill's name, and a cell's. */
export const SKILL_NAME = /^[a-z][a-z0-9-]{0,31}$/u
/** The one pinned cell whose program is a ROM, checked word by word (docs/auma/kyber-cpu.md). */
export const KYBER_CELL = 'kyber-cpu'

/** One evidence case: a call in the cell's own op format and the answer the oracle gave for it. */
export interface SkillCase {
  readonly op: string
  readonly input: unknown
  readonly output: unknown
}

export interface PinnedSkillCell {
  readonly kind: 'pinned'
  readonly name: string
  readonly sha256: string
  readonly abi: 1
  readonly ops: readonly string[]
}
export interface ForgedSkillCell {
  readonly kind: 'forged'
  readonly name: string
  /** The forged cell's content address: sha256 of its admitted metered bytes. */
  readonly sha256: string
  /** sha256 of the UTF-8 bytes of its kept WAT. */
  readonly watSha256: string
  readonly abi: 1
  readonly ops: readonly string[]
}
export type SkillCell = PinnedSkillCell | ForgedSkillCell

export interface SkillRecord {
  readonly schema: typeof SKILL_SCHEMA
  readonly name: string
  readonly cell: SkillCell
  /** The op `run` calls; one of `cell.ops`. */
  readonly op: string
  readonly program: { readonly digest: string }
  readonly weights: { readonly digest: string; readonly scalars: number } | null
  readonly state: { readonly schema: string }
  readonly evidence: { readonly cases: readonly SkillCase[]; readonly oracle: string }
}

/** The artifacts a record names, presented as their exact bytes. */
export interface SkillArtifacts {
  readonly cell: Uint8Array
  readonly program: Uint8Array
  /** Required exactly when the record's `weights` is not null. */
  readonly weights?: Uint8Array | null
  /** Required exactly when the record's cell is forged: the kept WAT's UTF-8 bytes. */
  readonly wat?: Uint8Array | null
}

export type SkillVerdict =
  | { readonly ok: true; readonly id: string; readonly record: SkillRecord; readonly program: Record<string, unknown> }
  | { readonly ok: false; readonly code: SkillRefusal; readonly detail?: string }

export type SkillRefusal =
  | 'SKILL_ID_MISMATCH'
  | 'SKILL_RECORD_LIMIT'
  | 'SKILL_NOT_CANONICAL'
  | 'SKILL_SHAPE'
  | 'SKILL_CELL_MISMATCH'
  | 'SKILL_PROGRAM_MISMATCH'
  | 'SKILL_WEIGHTS_MISMATCH'
  | 'SKILL_EVIDENCE_MISMATCH'

const HEX64 = /^[0-9a-f]{64}$/u
const OP = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_.]{0,63})?$/u
const SCHEMA_NAME = /^[a-z][a-z0-9.-]{0,63}$/u
const encoder = new TextEncoder()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value).sort()
  const want = [...keys].sort()
  return own.length === want.length && own.every((key, index) => key === want[index])
}
const isCount = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum

/**
 * Read bytes that must be the cell ABI's canonical JSON of one value: strict UTF-8, then parsed, then encoded again, and
 * the encoding must be exactly the bytes given (so no duplicate key, no whitespace, no float, no other escape survives).
 * @param bytes - the presented bytes.
 * @returns the value.
 * @throws when the bytes are not that canonical form.
 */
export function parseCanonical(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const value: unknown = JSON.parse(text)
  if (cellCanonicalJson(value) !== text) throw new Error('not the canonical form')
  return value
}

/** The canonical bytes of any JSON value (cellCanonicalJson, UTF-8). */
export const canonicalBytes = (value: unknown): Uint8Array => encoder.encode(cellCanonicalJson(value))

/**
 * The record's shape, exactly: every key present and no other, the schema, names, hex digests, ops and counts in range.
 * @param value - a parsed or host value.
 * @returns the first problem, or null when the shape is exact.
 */
export function skillShapeProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'record is not an object'
  if (!exactKeys(value, ['schema', 'name', 'cell', 'op', 'program', 'weights', 'state', 'evidence'])) return 'record keys'
  if (value.schema !== SKILL_SCHEMA) return 'schema'
  if (typeof value.name !== 'string' || !SKILL_NAME.test(value.name)) return 'name'
  const cell = value.cell
  if (!isRecord(cell)) return 'cell keys'
  if (cell.kind === 'pinned') {
    if (!exactKeys(cell, ['kind', 'name', 'sha256', 'abi', 'ops'])) return 'cell keys'
  } else if (cell.kind === 'forged') {
    if (!exactKeys(cell, ['kind', 'name', 'sha256', 'watSha256', 'abi', 'ops'])) return 'cell keys'
    if (typeof cell.watSha256 !== 'string' || !HEX64.test(cell.watSha256)) return 'cell.watSha256'
  } else return 'cell.kind'
  if (typeof cell.name !== 'string' || !SKILL_NAME.test(cell.name)) return 'cell.name'
  if (typeof cell.sha256 !== 'string' || !HEX64.test(cell.sha256)) return 'cell.sha256'
  if (cell.abi !== 1) return 'cell.abi'
  if (!Array.isArray(cell.ops) || cell.ops.length === 0 || cell.ops.length > 64
    || cell.ops.some(op => typeof op !== 'string' || !OP.test(op))) return 'cell.ops'
  if (typeof value.op !== 'string' || !cell.ops.includes(value.op)) return 'op'
  const program = value.program
  if (!isRecord(program) || !exactKeys(program, ['digest'])) return 'program keys'
  if (typeof program.digest !== 'string' || !HEX64.test(program.digest)) return 'program.digest'
  const weights = value.weights
  if (weights !== null) {
    if (!isRecord(weights) || !exactKeys(weights, ['digest', 'scalars'])) return 'weights keys'
    if (typeof weights.digest !== 'string' || !HEX64.test(weights.digest)) return 'weights.digest'
    if (!isCount(weights.scalars, 1)) return 'weights.scalars'
  }
  const state = value.state
  if (!isRecord(state) || !exactKeys(state, ['schema'])) return 'state keys'
  if (typeof state.schema !== 'string' || !SCHEMA_NAME.test(state.schema)) return 'state.schema'
  const evidence = value.evidence
  if (!isRecord(evidence) || !exactKeys(evidence, ['cases', 'oracle'])) return 'evidence keys'
  if (typeof evidence.oracle !== 'string' || evidence.oracle.length === 0 || evidence.oracle.length > 256) return 'evidence.oracle'
  if (!Array.isArray(evidence.cases) || evidence.cases.length === 0 || evidence.cases.length > SKILL_MAX_CASES) return 'evidence.cases'
  for (const entry of evidence.cases) {
    if (!isRecord(entry) || !exactKeys(entry, ['op', 'input', 'output'])) return 'evidence case keys'
    if (typeof entry.op !== 'string' || !cell.ops.includes(entry.op)) return 'evidence case op'
  }
  return null
}

/**
 * The canonical bytes of a record, after the exact shape check.
 * @param record - the record.
 * @returns its canonical text.
 * @throws when the shape is not exact, or the value is not canonical JSON (a float, an unpaired surrogate).
 */
export function encodeSkill(record: SkillRecord): Uint8Array {
  const problem = skillShapeProblem(record)
  if (problem !== null) throw new Error(`SKILL_SHAPE: ${problem}`)
  return canonicalBytes(record)
}

const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')

/**
 * The plain sha256 of an artifact's exact bytes, lowercase hex.
 * @param bytes - the artifact.
 * @returns lowercase hex.
 */
export async function artifactDigest(bytes: Uint8Array): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}

/**
 * A record's id: sha256(utf8("aukora.skill.v1\n") || bytes), lowercase hex. Hashes the bytes it is given; never parses.
 * @param bytes - the record's canonical bytes.
 * @returns the id.
 */
export function skillId(bytes: Uint8Array): Promise<string> {
  const domain = encoder.encode(SKILL_ID_DOMAIN)
  const message = new Uint8Array(domain.byteLength + bytes.byteLength)
  message.set(domain, 0)
  message.set(bytes, domain.byteLength)
  return artifactDigest(message)
}

/** Equal as canonical JSON (the cell ABI's), never by reference. A value that cannot be encoded equals nothing. */
export function sameCanonical(left: unknown, right: unknown): boolean {
  try { return cellCanonicalJson(left) === cellCanonicalJson(right) } catch { return false }
}

/** The Kyber CPU program: exactly `{ rom: [8 words, 0..1023] }`. */
const kyberRom = (program: Record<string, unknown>): readonly number[] | null => {
  const rom = program.rom
  return exactKeys(program, ['rom']) && Array.isArray(rom) && rom.length === 8 && rom.every(word => isCount(word, 0) && word <= 1023)
    ? rom as number[] : null
}

/**
 * Whether one evidence input is about this program. For `kyber-cpu`: its `rom`, or its checkpoint's `rom`, is the
 * program's ROM. For any other cell: the input is an object that carries every program key with the program's value.
 */
function caseAboutProgram(record: SkillRecord, program: Record<string, unknown>, input: unknown): boolean {
  if (!isRecord(input)) return false
  if (record.cell.kind === 'pinned' && record.cell.name === KYBER_CELL) {
    const rom = program.rom as number[]
    const matches = (value: unknown): boolean => Array.isArray(value)
      && value.length === rom.length && value.every((word, index) => word === rom[index])
    return !((!('rom' in input) && !('checkpoint' in input))
      || ('rom' in input && !matches(input.rom))
      || ('checkpoint' in input && (!isRecord(input.checkpoint) || !matches(input.checkpoint.rom))))
  }
  return Object.keys(program).every(key => Object.hasOwn(input, key) && sameCanonical(input[key], program[key]))
}

/**
 * A program as the cell will see it, or null: canonical bytes of an object of at most 32 keys (for `kyber-cpu`, exactly
 * its ROM).
 * @param record - the record (its cell decides the program's form).
 * @param bytes - the program's bytes.
 */
export function readSkillProgram(record: Pick<SkillRecord, 'cell'>, bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.byteLength === 0 || bytes.byteLength > SKILL_MAX_PROGRAM_BYTES) return null
  let program: unknown
  try { program = parseCanonical(bytes) } catch { return null }
  if (!isRecord(program) || Object.keys(program).length > 32) return null
  if (record.cell.kind === 'pinned' && record.cell.name === KYBER_CELL && kyberRom(program) === null) return null
  return program
}

/**
 * The input one `run` sends to the cell: the program's keys, then the caller's (which may not name a program key).
 * @param program - the verified program.
 * @param input - the caller's input object.
 * @returns the call input, or null when the input is not an object or names a program key.
 */
export function skillCallInput(program: Record<string, unknown>, input: unknown): Record<string, unknown> | null {
  if (!isRecord(input) || Object.keys(input).some(key => Object.hasOwn(program, key))) return null
  return { ...program, ...input }
}

/**
 * Verify a presented record against the exact artifacts it names. In order, the first failure wins: the id (when one is
 * presented, the raw bytes are hashed BEFORE they are parsed), the size, canonical text, exact shape, then the cell (and a
 * forged cell's WAT), program and weights digests recomputed from their bytes, the program's form, that every evidence
 * case is about this program, and the weight scalar count. A record that verifies is a description; it grants nothing.
 * @param record - the record's bytes as presented.
 * @param artifacts - the cell, program and weights bytes (and a forged cell's WAT).
 * @param id - the id the record was presented under, if any.
 * @returns the verdict, with the program as the cell will see it.
 */
export async function verifySkill(record: Uint8Array, artifacts: SkillArtifacts, id?: string): Promise<SkillVerdict> {
  const recordId = await skillId(record)
  if (id !== undefined && recordId !== id) return { ok: false, code: 'SKILL_ID_MISMATCH', detail: recordId }
  if (record.byteLength > SKILL_MAX_RECORD_BYTES) return { ok: false, code: 'SKILL_RECORD_LIMIT' }
  let parsed: unknown
  try {
    parsed = parseCanonical(record)
  } catch (error) {
    return { ok: false, code: 'SKILL_NOT_CANONICAL', detail: error instanceof Error ? error.message : String(error) }
  }
  const problem = skillShapeProblem(parsed)
  if (problem !== null) return { ok: false, code: 'SKILL_SHAPE', detail: problem }
  const shaped = parsed as SkillRecord
  if (await artifactDigest(artifacts.cell) !== shaped.cell.sha256) return { ok: false, code: 'SKILL_CELL_MISMATCH' }
  if (shaped.cell.kind === 'forged') {
    const wat = artifacts.wat ?? null
    if (wat === null || await artifactDigest(wat) !== shaped.cell.watSha256) return { ok: false, code: 'SKILL_CELL_MISMATCH', detail: 'wat' }
  }
  if (await artifactDigest(artifacts.program) !== shaped.program.digest) return { ok: false, code: 'SKILL_PROGRAM_MISMATCH' }
  const weights = artifacts.weights ?? null
  if (shaped.weights === null ? weights !== null : weights === null || await artifactDigest(weights) !== shaped.weights.digest) {
    return { ok: false, code: 'SKILL_WEIGHTS_MISMATCH' }
  }
  const program = readSkillProgram(shaped, artifacts.program)
  if (program === null) return { ok: false, code: 'SKILL_PROGRAM_MISMATCH' }
  for (const entry of shaped.evidence.cases) {
    if (!caseAboutProgram(shaped, program, entry.input)) return { ok: false, code: 'SKILL_EVIDENCE_MISMATCH' }
  }
  if (weights !== null && shaped.weights !== null) {
    let graph: unknown
    try {
      graph = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(weights))
    } catch (error) {
      return { ok: false, code: 'SKILL_WEIGHTS_MISMATCH', detail: error instanceof Error ? error.message : String(error) }
    }
    if (!isRecord(graph) || graph.schema !== 'finite-affine-relu.v1' || !Array.isArray(graph.nodes)) return { ok: false, code: 'SKILL_WEIGHTS_MISMATCH' }
    let scalars = 0
    for (const node of graph.nodes) {
      if (!Array.isArray(node) || node.length !== 3 || !Array.isArray(node[2])) return { ok: false, code: 'SKILL_WEIGHTS_MISMATCH' }
      scalars += 1 + node[2].length
    }
    if (scalars !== shaped.weights.scalars) return { ok: false, code: 'SKILL_WEIGHTS_MISMATCH' }
  }
  return { ok: true, id: recordId, record: shaped, program }
}
