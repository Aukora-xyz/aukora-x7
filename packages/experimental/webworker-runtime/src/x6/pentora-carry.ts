// ---- PENTCODEC block begin ----
/**
 * `x6_cell { action: "carry", what: "kyber-cpu-weights", drop: "0-9" | "menger-80" | "none" }`, the experiment
 * in one call. She reads her own Kyber CPU weights (same-origin `/cells/kyber/cpu-weights.json`), checks them against the
 * shipped countdown skill record (the record by its pinned id, the weights by the record's digest and scalar count),
 * flattens them to the 1,329 scalars in the order (per node: the bias, then each term weight), encodes them onto the
 * 110 PENTORA directions with the pinned `pentora-codec` cell, drops the selected packets (`0-9` drops nodes 0..9;
 * `menger-80` drops all 30 face-centre packets at squared radius 1 and keeps the 80 Menger skeleton nodes at squared
 * radius 2 or 3; `none` keeps all 110), decodes the kept packets with the same cell, and says whether every scalar came
 * back. A compute: it reads two public files, runs one pinned cell twice and writes nothing. It is an instrument
 * (docs/auma/pentora-codec.md): not storage, not authentication, not privacy, and NOT an MDS code — as algebraic rank facts
 * about the code, any 11 lost packets have full rank 72 (`SOURCE: CODE-VERDICT.md`, not re-run here; 5 dead Menger
 * mirror-twin lines, 658,008 sets), while one specific loss of 40 packets lying on five great circles (20 corners + 16
 * edge-centres + 4 face-centres) leaves the 70 kept packets with rank 70/72 and defeats recovery (whereas plain Reed-Solomon
 * [110, 72] survives any 38 lost packets at one-eighth the slots). On structured shells/cubes (rank facts; 2-cube recovery
 * verified by the test's own BigInt solver, whereas `pentora.decode` decodes only the three named keep-sets `"all"`,
 * `"drop-0-9"`, `"menger-80"`): the 60 edge-centres alone have rank 72; any 2 whole cubes (50 points, 3 of 5 cubes lost)
 * have rank 72; 1 cube alone (26 points) gives rank 50/72 (short 22). `menger-80` uses the exact same 72-row Menger solver
 * as `"all"` (23-bit D = 6,082,560); under `menger-80` a wrong or missing face-centre packet is never seen and never
 * detected (only the 640 components of the 80 kept packets are checked), while recovery on valid kept packets is identical.
 * This whole file sits inside the PENTCODEC marked block that the kyber spec's no-authority scan allows by its marker.
 * It does not load skill-record.ts (only her skills tool in ball-loader.ts does: kyber-cpu.spec.ts); it derives the record id the
 * same way, sha256("aukora.skill.v1\n" || bytes), and its spec holds that equal to skill-record.ts `skillId`.
 * @module x6/pentora-carry
 */
import type { CellCaller } from './cell-journal.ts'
import type { CellHost } from './wasm-cells.ts'

/** The shipped countdown skill record's id (kyber-cpu.spec.ts COUNTDOWN_ID): the record that names her weights. */
export const CARRY_RECORD_ID = '1205ded1b88bba84abc4fd171529b7ae2fc35e1cd8890f68651e745d8e1fcada'
export const CARRY_RECORD_PATH = '/cells/kyber/skills/countdown.json'
export const CARRY_WEIGHTS_PATH = '/cells/kyber/cpu-weights.json'
/** Neither file is anywhere near this; a larger answer is refused unread. */
export const CARRY_MAX_BYTES = 1024 * 1024
/** The 30 face-centre nodes (squared radius 1 in the pinned PENTORA geometry), dropped by `menger-80`. */
export const FACE_30_NODES: readonly number[] = Object.freeze([
  14, 20, 21, 24, 25, 29, 30, 35, 36, 39, 40, 41, 42, 50, 54,
  55, 59, 67, 68, 69, 70, 73, 74, 79, 80, 84, 85, 88, 89, 95,
])
const FACE_30_SET: ReadonlySet<number> = new Set(FACE_30_NODES)
/** The 80 Menger skeleton nodes (squared radius 2 or 3 in the pinned PENTORA geometry), kept in sorted order 0..109 by `menger-80`. */
export const MENGER_80_NODES: readonly number[] = Object.freeze(
  Array.from({ length: 110 }, (_, n) => n).filter(n => !FACE_30_SET.has(n)),
)
type CarryKeepSet = 'all' | 'drop-0-9' | 'menger-80'
export interface CarryCarrierDisclosure {
  readonly mds: false
  readonly keep: CarryKeepSet
  readonly kept: number
  readonly checkedRows: number
  readonly sameSolverAsAll: boolean
  readonly worstCaseAnyLossSurvived: 11
  readonly mengerTwinLineSetsChecked: 658_008
  readonly worstCaseSource: 'CODE-VERDICT.md'
  readonly defeatingFortyPacketGreatCircleLossRank: 70
  readonly reedSolomon110_72AnyLossSurvived: 38
  readonly edgeCentres60Rank: 72
  readonly anyTwoCubes50Rank: 72
  readonly oneCube26Rank: 50
  readonly note: string
}
export const CARRY_CARRIER_NOTE =
  'Structured carrier, not an MDS code (rank facts about the code; this cell decodes only the three named keep-sets '
  + '"all", "drop-0-9" and "menger-80", refusing any other with PENTORA_KEEP_UNSUPPORTED): any 11 lost packets retain rank 72 '
  + '(SOURCE CODE-VERDICT.md, 5 dead Menger mirror-twin lines = 658,008 sets, not re-run exhaustively here), while one specific '
  + 'loss of 40 packets lying on five great circles (20 corners + 16 edge-centres + 4 face-centres) leaves the 70 kept packets '
  + 'at rank 70/72 and defeats recovery (plain Reed-Solomon [110, 72] survives any 38 lost packets at one-eighth the slots). '
  + '60 edge-centres alone have rank 72; any 2 whole cubes (50 points, 3 of 5 cubes lost) have rank 72 and recover all 1,329 '
  + 'weights by the test\'s own BigInt solver (not by the cell); 1 cube alone (26 points) gives rank 50/72 (short 22). '
  + 'menger-80 uses the exact same 72-row Menger solver as "all" (23-bit D = 6,082,560); under menger-80 a wrong or missing '
  + 'face-centre packet is never seen and never detected — only the 640 components of the 80 kept packets are checked.'
export function carryCarrierDisclosure(keep: CarryKeepSet, dropped: number): CarryCarrierDisclosure {
  const kept = 110 - dropped
  return Object.freeze({
    mds: false, keep, kept, checkedRows: kept * 8, sameSolverAsAll: keep !== 'drop-0-9',
    worstCaseAnyLossSurvived: 11, mengerTwinLineSetsChecked: 658_008, worstCaseSource: 'CODE-VERDICT.md',
    defeatingFortyPacketGreatCircleLossRank: 70, reedSolomon110_72AnyLossSurvived: 38,
    edgeCentres60Rank: 72, anyTwoCubes50Rank: 72, oneCube26Rank: 50, note: CARRY_CARRIER_NOTE,
  })
}
interface CarryDropSpec {
  readonly keep: CarryKeepSet
  readonly dropped: number
  readonly select: (packets: readonly unknown[]) => unknown[]
}
const CARRY_DROPS: Readonly<Record<string, CarryDropSpec>> = Object.freeze({
  '0-9': { keep: 'drop-0-9', dropped: 10, select: packets => packets.slice(10) },
  'menger-80': { keep: 'menger-80', dropped: 30, select: packets => MENGER_80_NODES.map(n => packets[n]) },
  'none': { keep: 'all', dropped: 0, select: packets => [...packets] },
})

export interface CarryDeps {
  readonly origin: string | undefined
  readonly fetchImpl: typeof fetch
}

const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
/** SHA-256 of exact bytes (WebCrypto), lower-case hex. */
export async function carrySha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
}
/** A skill record's id: sha256("aukora.skill.v1\n" || its exact bytes), as skill-record.ts `skillId` computes it. */
export function carryRecordId(bytes: Uint8Array): Promise<string> {
  const domain = new TextEncoder().encode('aukora.skill.v1\n')
  const message = new Uint8Array(domain.byteLength + bytes.byteLength)
  message.set(domain, 0)
  message.set(bytes, domain.byteLength)
  return carrySha256(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

async function readSameOrigin(deps: CarryDeps, path: string): Promise<Uint8Array | null> {
  if (!deps.origin || deps.origin === 'null') return null
  try {
    const response = await deps.fetchImpl(new URL(path, deps.origin).href, { cache: 'no-store' })
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > 0 && bytes.byteLength <= CARRY_MAX_BYTES ? bytes : null
  } catch {
    return null
  }
}

/** The 1,329 scalars of a finite-affine-relu.v1 graph, in the order: per node, the bias, then each term weight. */
export function carryScalars(graph: unknown): number[] | null {
  if (!isRecord(graph) || graph.schema !== 'finite-affine-relu.v1' || !Array.isArray(graph.nodes)) return null
  const out: number[] = []
  for (const node of graph.nodes) {
    if (!Array.isArray(node) || node.length !== 3 || !Array.isArray(node[2])) return null
    out.push(node[0] as number)
    for (const term of node[2] as unknown[]) {
      if (!Array.isArray(term) || term.length !== 2) return null
      out.push(term[1] as number)
    }
  }
  return out.every(v => Number.isSafeInteger(v) && v >= -32768 && v <= 32767) ? out : null
}

/** SHA-256 of the scalars as little-endian int16 (the decoded-weight digest). */
export function int16Sha256(values: readonly number[]): Promise<string> {
  const bytes = new Uint8Array(values.length * 2)
  const view = new DataView(bytes.buffer)
  values.forEach((v, i) => { view.setInt16(i * 2, v, true) })
  return carrySha256(bytes)
}

/**
 * Run the carry.
 * @param cells - this worker's cell host (the call journals as `x6_cell`).
 * @param args - `{ what: "kyber-cpu-weights", drop?: "0-9" | "menger-80" | "none" }` (drop defaults to "0-9").
 * @returns `{ ok, scalars, packets, dropped, recovered, exact, weightsSha256, recoveredSha256, same, fuelUsed, carrier }`, or a
 *   closed refusal `{ ok: false, code }` (CARRY_WHAT_UNKNOWN, CARRY_DROP_UNSUPPORTED, CARRY_RECORD_UNAVAILABLE,
 *   CARRY_RECORD_MISMATCH, CARRY_WEIGHTS_UNAVAILABLE, CARRY_WEIGHTS_MISMATCH, or the cell's own code).
 */
export async function pentoraCarry(cells: CellHost, args: Record<string, unknown>, deps: CarryDeps,
  caller: CellCaller = 'x6_cell'): Promise<Record<string, unknown>> {
  if (args.what !== 'kyber-cpu-weights') return { ok: false, code: 'CARRY_WHAT_UNKNOWN', what: ['kyber-cpu-weights'] }
  const dropName = args.drop === undefined ? '0-9' : args.drop
  const drop = typeof dropName === 'string' && Object.hasOwn(CARRY_DROPS, dropName) ? CARRY_DROPS[dropName] : undefined
  if (drop === undefined) return { ok: false, code: 'CARRY_DROP_UNSUPPORTED', drop: Object.keys(CARRY_DROPS) }
  const recordBytes = await readSameOrigin(deps, CARRY_RECORD_PATH)
  if (recordBytes === null) return { ok: false, code: 'CARRY_RECORD_UNAVAILABLE' }
  if (await carryRecordId(recordBytes) !== CARRY_RECORD_ID) return { ok: false, code: 'CARRY_RECORD_MISMATCH' }
  let weightsRef: unknown
  try { weightsRef = (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(recordBytes)) as Record<string, unknown>).weights } catch { weightsRef = null }
  if (!isRecord(weightsRef) || typeof weightsRef.digest !== 'string' || typeof weightsRef.scalars !== 'number') {
    return { ok: false, code: 'CARRY_RECORD_MISMATCH' }
  }
  const weightBytes = await readSameOrigin(deps, CARRY_WEIGHTS_PATH)
  if (weightBytes === null) return { ok: false, code: 'CARRY_WEIGHTS_UNAVAILABLE' }
  if (await carrySha256(weightBytes) !== weightsRef.digest) return { ok: false, code: 'CARRY_WEIGHTS_MISMATCH' }
  let graph: unknown
  try { graph = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(weightBytes)) } catch { graph = null }
  const scalars = carryScalars(graph)
  if (scalars === null || scalars.length !== weightsRef.scalars) return { ok: false, code: 'CARRY_WEIGHTS_MISMATCH' }

  const encoded = await cells.invoke('pentora-codec', 'pentora.encode', { values: scalars }, caller)
  if (!encoded.ok) return { ok: false, code: encoded.code, step: 'encode' }
  const packets = (encoded.result as { packets?: unknown }).packets
  if (!Array.isArray(packets) || packets.length !== 110) return { ok: false, code: 'CARRY_PACKETS_SHAPE', step: 'encode' }
  const decoded = await cells.invoke('pentora-codec', 'pentora.decode',
    { count: scalars.length, keep: drop.keep, packets: drop.select(packets) }, caller)
  const fuelUsed = encoded.fuelUsed + (decoded.fuelUsed ?? 0)
  if (!decoded.ok) return { ok: false, code: decoded.code, step: 'decode', fuelUsed }
  const result = decoded.result as { values?: unknown; residual?: unknown }
  const values = Array.isArray(result.values) ? result.values as unknown[] : []
  const recovered = values.length === scalars.length ? values.filter((v, i) => v === scalars[i]).length : 0
  const weightsSha256 = await int16Sha256(scalars)
  const recoveredSha256 = values.every(v => Number.isSafeInteger(v) && (v as number) >= -32768 && (v as number) <= 32767)
    ? await int16Sha256(values as number[]) : null
  return {
    ok: true, scalars: scalars.length, packets: packets.length, dropped: drop.dropped, recovered,
    exact: recovered === scalars.length && result.residual === 'exact',
    weightsSha256, recoveredSha256, same: recovered === scalars.length && recoveredSha256 === weightsSha256, fuelUsed,
    carrier: carryCarrierDisclosure(drop.keep, drop.dropped),
  }
}
// ---- PENTCODEC block end ----
