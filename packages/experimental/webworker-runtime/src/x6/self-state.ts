/**
 * `x6_self_state`: what THIS session of hers is actually running, said from inside.
 *
 * The repository mirror, the selected head and her running body are three different things. This read answers for the
 * running body: the revision baked into the runtime she executes, the revision her edge says it runs (one GET
 * `/api/build`), the head the loader holds, and for every organ the SHA-256 of the exact text the loader EVALUATED for it
 * in this session (recorded by ball-loader.ts at evaluation, never recomputed from a file), beside the SHA-256 of her
 * organ store file as it is on disk NOW (`/dsh/home/auma/seed/organs/<id>.js`, the file she edits).
 *
 * Nothing is assumed: a value the loader does not hold is null and has exactly one row in `unknown` with a closed reason.
 * It writes nothing (no VFS write, no IndexedDB, no storage), mounts nothing and runs no organ code; its one request is
 * the same-origin GET of `/api/build`. One closed JSON object of at most 16 KiB, keys in a fixed order: a long list is cut
 * with a `too-many` row, never sent oversized.
 * @module x6/self-state
 */
import { sha256HexSync } from '../module-system/module-loader.ts'
import { PRIVATE_ROOT } from './browser-estate.ts'
import { withholdSecrets } from './secret-shapes.ts'
import { NUCLEUS_SHADOW_MISMATCHES_KEPT, type NucleusShadowTally } from './nucleus-shadow.ts'
import { NUCLEUS_TIER_FACT_NAMES, NUCLEUS_TIER_OUTCOME_BITS } from './nucleus-tier.ts'
import { CELL_LOAD_FAILURES, type CellJournalSummary, type CellRow } from './cell-journal.ts'
import type { CellHost } from './wasm-cells.ts'
import { claudeStepUsd } from '../claude-prices.ts'

export const SELF_STATE_SCHEMA = 'aukora.self-state.v1' as const
export const SELF_STATE_RESULT_BYTES = 16 * 1024
export const SELF_STATE_EDGE_PATH = '/api/build'
export const SELF_STATE_EDGE_TIMEOUT_MS = 4000
export const SELF_STATE_EDGE_MAX_BYTES = 4 * 1024
/** Her organ store: the named source files she edits (hydrated from the selected head, mirrored to the repository). */
export const SELF_STATE_ORGAN_STORE_DIR = '/dsh/home/auma/seed/organs'
export const SELF_STATE_STAGED_MAX = 64
/** Organs considered (and store files read) before the byte fit; more are cut with a `too-many` row. */
export const SELF_STATE_ORGANS_MAX = 128
export const SELF_STATE_TOOLS_MAX = 256
/** Ids one `organs` argument may name. */
export const SELF_STATE_ORGAN_FILTER_MAX = 64
/** The longest the read waits for in-flight cell-journal lines before its snapshot. */
export const SELF_STATE_SETTLE_MS = 1000
/** Pinned-cell rows considered; a registry with more is not that shape (read-failed). */
export const SELF_STATE_CELLS_MAX = 64
/** Kept forged-cell rows considered; a registry with more is not that shape (read-failed). At least
 * ball-loader.ts FORGED_CELLS_MAX (128 since the raised limits; was 64 here), so a full shelf still shows. */
export const SELF_STATE_FORGED_CELLS_MAX = 128
/** Kept-skill rows considered; a registry with more is not that shape (read-failed). At least the kept-skill cap in
 * ball-loader.ts (256 since the raised limits; was 64 here), so a full shelf still shows. */
export const SELF_STATE_SKILLS_MAX = 256

export type SelfStateReason = 'not-recorded' | 'unreachable' | 'not-registered' | 'too-many' | 'read-failed'
export interface SelfStateUnknown { readonly field: string; readonly reason: SelfStateReason }

/** What the loader recorded when it evaluated a module: the SHA-256 and byte length of the text it evaluated. */
export interface SelfStateLoaded { readonly sha256: string; readonly bytes: number }

/** One HEAD entry as the loader holds it. `loaded` is the record for the specifier its fiber runs, or null. */
export interface SelfStateOrganRecord {
  readonly id: string
  readonly specifier: string
  readonly loaded: SelfStateLoaded | null
  readonly state: string
}

/** A read-only snapshot of the loader's own registry, taken in one synchronous step. */
export interface SelfStateRegistry {
  readonly sourceRevision: string | null
  readonly bootedAtMs: number
  readonly head: { readonly ballId: string; readonly epoch: number; readonly origin: 'host' | 'local' } | null
  readonly organs: readonly SelfStateOrganRecord[]
  readonly staged: ReadonlyArray<{ readonly sha256: string; readonly name: string }>
  /** Tool names registered in this session, or null when the registry could not be read. */
  readonly tools: readonly string[] | null
  /** Her Cloudflare door: whether the tool is registered, and the last `status` answer this session read (never a secret). */
  readonly cloudflareDoor: {
    readonly registered: boolean
    readonly status: { readonly level: string; readonly configured: boolean } | null
  }
  /** This session's shadow-consult tally (nucleus-shadow.ts). Absent: the answer carries no such key. */
  readonly nucleusShadow?: NucleusShadowTally
  /**
   * One row per pinned cell, with what this session's cell host saw when it loaded it (wasm-cells.ts
   * cellRows). Absent: the answer carries no `cellCount` or `cells`; null: the host could not be read.
   */
  readonly cells?: readonly CellRow[] | null
  /** The cell-call journal's settled count and root. Absent: no `cellJournal` key; null: not readable. */
  readonly cellJournal?: CellJournalSummary | null
  /**
   * The cells she forged and keeps in her home (ball-loader.ts listForgedCells), newest first. Absent: no
   * `forgedCells` key; null: her store could not be read.
   */
  readonly forgedCells?: ReadonlyArray<{ readonly name: string; readonly sha256: string; readonly bytes: number }> | null
  /**
   * The skills she keeps in her home (read by her skills tool in ball-loader.ts), newest first: name and id only. Absent: no
   * `skills` key; null: her store could not be read.
   */
  readonly skills?: ReadonlyArray<{ readonly name: string; readonly id: string }> | null
  /**
   * This page load's thread sync (storage/thread-sync.ts `threadSyncSelfState`): `mode`, `role`, `sent` and
   * `pending` whole lines, `lastOkAtMs`, `lastError`. CARD 1.5 added `bytes` (her cloud accepted this load) and
   * `pendingBytes` (bytes no acknowledgement covers) — OPTIONAL here on purpose: a worker from before this card sends the
   * old six-key shape and it still passes through unchanged. Absent: no `threadSync` key; null: not readable.
   */
  readonly threadSync?: {
    readonly mode: string | null
    readonly role: string | null
    readonly sent: number
    readonly bytes?: number
    readonly pending: number
    readonly pendingBytes?: number
    readonly lastOkAtMs: number | null
    readonly lastError: string | null
  } | null
  /** What her model steps cost in this page life (the the cost change block below). Absent: no `spend` key; wrong shape: null. */
  readonly spend?: SpendSnapshot
}

/** The edge's answer to GET /api/build, reduced to the revision or a reason. */
export interface SelfStateEdge { readonly sourceRevision: string | null; readonly reason: SelfStateReason | null }

/** Everything one answer is projected from. `store` maps an organ id to its store file's SHA-256, or null (read-failed). */
export interface SelfStateObservation {
  readonly registry: SelfStateRegistry
  readonly store: Readonly<Record<string, string | null>>
  readonly edge: SelfStateEdge
  /** The ids the caller asked for, or null for all. */
  readonly organFilter: readonly string[] | null
}

type Json = Record<string, unknown>
const SHA = /^[a-f0-9]{64}$/
const REVISION = /^[0-9a-f]{40,64}$/
const BALL_SPECIFIER = /^ball:[a-f0-9]{64}$/
const STORE_ID = /^[a-z][a-z0-9-]{0,63}$/
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/
const STATES = new Set(['running', 'disabled', 'support-module', 'not-running'])
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Free text leaves through the secret-shape filter, cut, and never as a path in her private room. */
function safeText(value: string, max = 80): string {
  if (value === PRIVATE_ROOT || value.includes(`${PRIVATE_ROOT}/`) || value.includes('/private/')) return '[withheld]'
  const text = withholdSecrets(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A content address stays as it is (a module's public name); anything else is free text. */
const safeSpecifier = (specifier: string): string => BALL_SPECIFIER.test(specifier) ? specifier : safeText(specifier, 160)

/** Her organ store file for an entry id, or null when the id has no store name. */
export function organStorePath(id: string): string | null {
  return STORE_ID.test(id) ? `${SELF_STATE_ORGAN_STORE_DIR}/${id}.js` : null
}

/** The `level` and `configured` of one `x6_cloudflare status` answer, or null when it is not that shape. Never a secret. */
export function cloudflareDoorStatusOf(answer: unknown): { level: 'open' | 'guarded'; configured: boolean } | null {
  if (!record(answer) || answer.ok !== true || (answer.level !== 'open' && answer.level !== 'guarded')
    || typeof answer.brokerConfigured !== 'boolean' || typeof answer.accountConfigured !== 'boolean') return null
  return { level: answer.level, configured: answer.brokerConfigured && answer.accountConfigured }
}

/** Validate the optional `organs` argument: a list of 1..64 ids. */
export function parseOrganFilter(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length === 0 || value.length > SELF_STATE_ORGAN_FILTER_MAX
    || value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 128)) {
    throw new Error(`SELF_STATE_ORGANS_INVALID: organs is a list of 1 to ${String(SELF_STATE_ORGAN_FILTER_MAX)} organ ids`)
  }
  return [...new Set(value as string[])].sort()
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The organs an answer may carry: narrowed, sorted by id, at most SELF_STATE_ORGANS_MAX. */
export function selectOrgans(registry: SelfStateRegistry, filter: readonly string[] | null): {
  organs: SelfStateOrganRecord[]
  cut: boolean
  missing: string[]
} {
  const all = [...registry.organs].filter(organ => filter === null || filter.includes(organ.id)).sort((a, b) => byString(a.id, b.id))
  const present = new Set(registry.organs.map(organ => organ.id))
  return { organs: all.slice(0, SELF_STATE_ORGANS_MAX), cut: all.length > SELF_STATE_ORGANS_MAX,
    missing: (filter ?? []).filter(id => !present.has(id)) }
}

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const tierNames = (value: unknown): string[] | null => Array.isArray(value) && value.length <= NUCLEUS_TIER_OUTCOME_BITS.length
  && value.every(name => (NUCLEUS_TIER_OUTCOME_BITS as readonly unknown[]).includes(name)) ? [...value as string[]] : null

/**
 * The shadow tally as the answer shows it (fixed keys, at most NUCLEUS_SHADOW_MISMATCHES_KEPT mismatches, names from the
 * reflex's closed lists only), or null when the registry's value is not that shape.
 */
export function nucleusShadowView(value: unknown): Json | null {
  if (!record(value) || typeof value.reflex !== 'string' || !SHA.test(value.reflex) || !count(value.consulted) || !count(value.agree)
    || !count(value.mismatch) || !count(value.unknown) || !Array.isArray(value.lastMismatches)
    || value.lastMismatches.length > NUCLEUS_SHADOW_MISMATCHES_KEPT) return null
  const mismatches: Json[] = []
  for (const item of value.lastMismatches as unknown[]) {
    if (!record(item) || !count(item.at) || !record(item.facts) || !record(item.nucleus) || !record(item.edge)) return null
    const facts = item.facts, nucleus = item.nucleus, edge = item.edge
    if (NUCLEUS_TIER_FACT_NAMES.some((name) => { const value = facts[name]; return !count(value) || value > 2 })) return null
    const nucleusReasons = tierNames(nucleus.reasons), edgeReasons = tierNames(edge.reasons)
    if (!count(nucleus.decision) || (nucleus.escalate !== 0 && nucleus.escalate !== 1) || nucleusReasons === null
      || (edge.tier !== 'T1' && edge.tier !== 'T2') || edgeReasons === null) return null
    mismatches.push({ at: item.at, facts: Object.fromEntries(NUCLEUS_TIER_FACT_NAMES.map(name => [name, facts[name]])),
      nucleus: { decision: nucleus.decision, reasons: nucleusReasons, escalate: nucleus.escalate },
      edge: { tier: edge.tier, reasons: edgeReasons } })
  }
  return { reflex: value.reflex, consulted: value.consulted, agree: value.agree, mismatch: value.mismatch, unknown: value.unknown,
    lastMismatches: mismatches }
}

const CELL_NAME = /^[a-z][a-z0-9-]{0,63}$/
const CELL_OP = /^[a-z][a-z0-9_.]{0,96}$/
const CELL_LOADED = new Set(['not-loaded', 'verified', 'failed'])

/** The cell rows as the answer shows them (sorted by name, fixed keys), or null when the registry's value is not that shape. */
export function cellRowsView(value: unknown): Json[] | null {
  if (!Array.isArray(value) || value.length > SELF_STATE_CELLS_MAX) return null
  const rows: Json[] = []
  for (const row of value as unknown[]) {
    if (!record(row) || typeof row.cell !== 'string' || !CELL_NAME.test(row.cell) || typeof row.sha256 !== 'string' || !SHA.test(row.sha256)
      || (row.bytes !== null && !count(row.bytes)) || !count(row.fuel) || !Array.isArray(row.ops) || row.ops.length > 64
      || row.ops.some(op => typeof op !== 'string' || !CELL_OP.test(op)) || typeof row.loaded !== 'string' || !CELL_LOADED.has(row.loaded)) return null
    const failed = row.loaded === 'failed'
    if (failed ? !(CELL_LOAD_FAILURES as readonly unknown[]).includes(row.failure) : row.failure !== undefined) return null
    rows.push({ cell: row.cell, sha256: row.sha256, bytes: row.bytes, fuel: row.fuel, ops: [...row.ops as string[]], loaded: row.loaded,
      ...(failed ? { failure: row.failure } : {}) })
  }
  const names = rows.map(row => row.cell as string)
  if (new Set(names).size !== names.length) return null
  return rows.sort((a, b) => byString(a.cell as string, b.cell as string))
}

/** The journal summary as the answer shows it, or null when it is not that shape. */
export function cellJournalView(value: unknown): Json | null {
  return record(value) && count(value.calls) && typeof value.rootSha256 === 'string' && SHA.test(value.rootSha256)
    ? { calls: value.calls, rootSha256: value.rootSha256 } : null
}

const FORGED_NAME = /^[a-z][a-z0-9-]{0,31}$/

/** The kept forged cells as the answer shows them (her order, newest first; fixed keys), or null when not that shape. */
export function forgedCellsView(value: unknown): Json[] | null {
  if (!Array.isArray(value) || value.length > SELF_STATE_FORGED_CELLS_MAX) return null
  const rows: Json[] = []
  for (const row of value as unknown[]) {
    if (!record(row) || typeof row.name !== 'string' || !FORGED_NAME.test(row.name) || typeof row.sha256 !== 'string'
      || !SHA.test(row.sha256) || !count(row.bytes)) return null
    rows.push({ name: row.name, sha256: row.sha256, bytes: row.bytes })
  }
  if (new Set(rows.map(row => row.sha256 as string)).size !== rows.length) return null
  return rows
}

/** The kept skills as the answer shows them (her order, newest first; fixed keys), or null when not that shape. */
export function keptSkillsView(value: unknown): Json[] | null {
  if (!Array.isArray(value) || value.length > SELF_STATE_SKILLS_MAX) return null
  const rows: Json[] = []
  for (const row of value as unknown[]) {
    if (!record(row) || typeof row.name !== 'string' || !FORGED_NAME.test(row.name) || typeof row.id !== 'string' || !SHA.test(row.id)) return null
    rows.push({ name: row.name, id: row.id })
  }
  if (new Set(rows.map(row => row.id as string)).size !== rows.length) return null
  return rows
}

const SYNC_MODES = new Set(['off', 'pull', 'on'])
const SYNC_ROLES = new Set(['reader', 'writer', 'none'])

/** The thread-sync facts as the answer shows them (fixed keys), or null when not that shape. */
export function threadSyncView(value: unknown): Json | null {
  // The keys thread sync has always had come first, and `bytes`/`pendingBytes` are OPTIONAL: they arrived with card 1.5,
  // so a worker from before it (or a page paired with one) must pass through with exactly the keys it sent, unchanged.
  if (!record(value) || !count(value.sent) || !count(value.pending)) return null
  if (value.bytes !== undefined && !count(value.bytes)) return null
  if (value.pendingBytes !== undefined && !count(value.pendingBytes)) return null
  const mode = value.mode === null || (typeof value.mode === 'string' && SYNC_MODES.has(value.mode)) ? value.mode : undefined
  const role = value.role === null || (typeof value.role === 'string' && SYNC_ROLES.has(value.role)) ? value.role : undefined
  const okAt = value.lastOkAtMs === null || count(value.lastOkAtMs) ? value.lastOkAtMs : undefined
  if (mode === undefined || role === undefined || okAt === undefined) return null
  if (value.lastError !== null && typeof value.lastError !== 'string') return null
  return { mode, role, sent: value.sent,
    ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
    pending: value.pending,
    ...(value.pendingBytes === undefined ? {} : { pendingBytes: value.pendingBytes }),
    lastOkAtMs: okAt,
    lastError: value.lastError === null ? null : safeText(value.lastError, 200) }
}

/** The registry's two cell facts from this session's cell host; a host that cannot answer gives null (read-failed). */
export function cellFactsOf(host: () => Pick<CellHost, 'cellRows' | 'journalSummary'>): Pick<SelfStateRegistry, 'cells' | 'cellJournal'> {
  let cells: readonly CellRow[] | null = null, cellJournal: CellJournalSummary | null = null
  try { cells = host().cellRows() } catch { cells = null }
  try { cellJournal = host().journalSummary() } catch { cellJournal = null }
  return { cells, cellJournal }
}

/**
 * Project one answer. Pure: no I/O, no clock. Key order is fixed by construction; lists are sorted; every null has
 * exactly one `unknown` row; the answer is at most SELF_STATE_RESULT_BYTES (the shadow's `lastMismatches` are cut first,
 * oldest first, then cell rows (the last names first), then forged-cell rows (the oldest first), then kept-skill rows (the
 * oldest first), then organs, then staged, then tools; the shadow's counts, `cellCount`, `cellJournal`, `forgedCells.count`
 * and `skills.count` are never cut).
 */
export function projectSelfState(observation: SelfStateObservation): Json {
  const { registry, store, edge } = observation
  const selection = selectOrgans(registry, observation.organFilter)
  const runtimeRevision = typeof registry.sourceRevision === 'string' && REVISION.test(registry.sourceRevision) ? registry.sourceRevision : null
  const edgeRevision = typeof edge.sourceRevision === 'string' && REVISION.test(edge.sourceRevision) ? edge.sourceRevision : null
  const head = registry.head !== null && SHA.test(registry.head.ballId) && Number.isSafeInteger(registry.head.epoch) ? registry.head : null
  const staged = [...new Map(registry.staged.filter(item => SHA.test(item.sha256)).map(item => [item.sha256, item] as const)).values()]
    .sort((a, b) => byString(a.sha256, b.sha256))
  const tools = registry.tools === null ? null : [...new Set(registry.tools.filter(name => typeof name === 'string' && TOOL_NAME.test(name)))].sort(byString)
  const door = registry.cloudflareDoor
  // Shown only when the loader keeps a shadow (it always does); a value of the wrong shape is null.
  const hasShadow = registry.nucleusShadow !== undefined
  const shadow = hasShadow ? nucleusShadowView(registry.nucleusShadow) : undefined
  const shadowMismatches = shadow ? shadow.lastMismatches as Json[] : []
  // Shown only when the loader passes the cell facts (it always does); a value of the wrong shape is null.
  const hasCells = registry.cells !== undefined
  const cellRows = hasCells ? cellRowsView(registry.cells) : null
  const allCells = cellRows ?? []
  const hasJournal = registry.cellJournal !== undefined
  const journal = hasJournal ? cellJournalView(registry.cellJournal) : null
  // Shown only when the loader passes them (it always does); a value of the wrong shape is null.
  const hasForged = registry.forgedCells !== undefined
  const forgedRows = hasForged ? forgedCellsView(registry.forgedCells) : null
  const allForged = forgedRows ?? []
  // Kept skills: shown only when the loader passes them (it always does); a value of the wrong shape is null.
  const hasSkills = registry.skills !== undefined
  const skillRows = hasSkills ? keptSkillsView(registry.skills) : null
  const allSkills = skillRows ?? []
  // Shown only when the loader passes it (it always does); a value of the wrong shape is null.
  const hasSync = registry.threadSync !== undefined
  const sync = hasSync ? threadSyncView(registry.threadSync) : null
  // Shown only when the loader passes it (it always does); a value of the wrong shape is null.
  const hasSpend = registry.spend !== undefined
  const spend = hasSpend ? spendView(registry.spend) : null

  const organRow = (organ: SelfStateOrganRecord, rows: SelfStateUnknown[]): Json => {
    const id = safeText(organ.id)
    const at = `organs[${id}]`
    const loaded = organ.loaded !== null && SHA.test(organ.loaded.sha256) && Number.isSafeInteger(organ.loaded.bytes) ? organ.loaded : null
    const storeSha = Object.hasOwn(store, organ.id) && typeof store[organ.id] === 'string' && SHA.test(store[organ.id] as string) ? store[organ.id] as string : null
    if (loaded === null) rows.push({ field: `${at}.sha256Loaded`, reason: 'not-recorded' }, { field: `${at}.bytes`, reason: 'not-recorded' })
    if (storeSha === null) rows.push({ field: `${at}.storeSha256`, reason: 'read-failed' })
    if (loaded === null || storeSha === null) rows.push({ field: `${at}.matchesStore`, reason: loaded === null ? 'not-recorded' : 'read-failed' })
    return {
      id, specifier: safeSpecifier(organ.specifier), sha256Loaded: loaded?.sha256 ?? null, bytes: loaded?.bytes ?? null,
      storeSha256: storeSha, matchesStore: loaded === null || storeSha === null ? null : loaded.sha256 === storeSha,
      state: STATES.has(organ.state) ? organ.state : safeText(organ.state, 32),
    }
  }

  const build = (organCount: number, stagedCount: number, toolCount: number, mismatchCount = shadowMismatches.length,
    cellCount = allCells.length, forgedCount = allForged.length, skillCount = allSkills.length): Json => {
    const rows: SelfStateUnknown[] = []
    if (runtimeRevision === null) rows.push({ field: 'runtime.sourceRevision', reason: 'not-recorded' })
    if (edgeRevision === null) rows.push({ field: 'edge.sourceRevision', reason: edge.reason ?? 'not-recorded' })
    if (head === null) rows.push({ field: 'head', reason: 'not-recorded' })
    const organs = selection.organs.slice(0, organCount).map(organ => organRow(organ, rows))
    if (organCount < selection.organs.length || selection.cut) rows.push({ field: 'organs', reason: 'too-many' })
    for (const id of selection.missing) rows.push({ field: `organs[${safeText(id)}]`, reason: 'not-registered' })
    const stagedOut = staged.slice(0, Math.min(stagedCount, SELF_STATE_STAGED_MAX))
      .map(item => ({ sha256: item.sha256, name: safeText(item.name) }))
    if (stagedOut.length < staged.length) rows.push({ field: 'staged', reason: 'too-many' })
    let toolsOut: string[] | null = null
    if (tools === null) rows.push({ field: 'tools', reason: 'read-failed' })
    else {
      toolsOut = tools.slice(0, Math.min(toolCount, SELF_STATE_TOOLS_MAX)).map(name => safeText(name, 64))
      if (toolsOut.length < tools.length) rows.push({ field: 'tools', reason: 'too-many' })
    }
    const cloudflare = door.registered && door.status !== null
      ? { level: safeText(door.status.level, 16), configured: door.status.configured } : null
    if (cloudflare === null) rows.push({ field: 'doors.cloudflare', reason: door.registered ? 'not-recorded' : 'not-registered' })
    if (shadow === null) rows.push({ field: 'nucleusShadow', reason: 'read-failed' })
    // The newest mismatches are kept; a cut list says so in one row (the counts above it are always whole).
    const shadowOut = shadow ? { ...shadow, lastMismatches: shadowMismatches.slice(shadowMismatches.length - mismatchCount) } : shadow
    if (shadow && mismatchCount < shadowMismatches.length) rows.push({ field: 'nucleusShadow.lastMismatches', reason: 'too-many' })
    const cellsOut = cellRows === null ? null : cellRows.slice(0, cellCount)
    if (hasCells && cellRows === null) rows.push({ field: 'cellCount', reason: 'read-failed' }, { field: 'cells', reason: 'read-failed' })
    if (cellsOut !== null && cellsOut.length < allCells.length) rows.push({ field: 'cells', reason: 'too-many' })
    for (const cell of cellsOut ?? []) if (cell.bytes === null) rows.push({ field: `cells[${String(cell.cell)}].bytes`, reason: 'not-recorded' })
    if (hasJournal && journal === null) rows.push({ field: 'cellJournal', reason: 'read-failed' })
    if (hasForged && forgedRows === null) rows.push({ field: 'forgedCells', reason: 'read-failed' })
    if (forgedRows !== null && forgedCount < allForged.length) rows.push({ field: 'forgedCells.cells', reason: 'too-many' })
    if (hasSkills && skillRows === null) rows.push({ field: 'skills', reason: 'read-failed' })
    if (skillRows !== null && skillCount < allSkills.length) rows.push({ field: 'skills.kept', reason: 'too-many' })
    if (hasSync && sync === null) rows.push({ field: 'threadSync', reason: 'read-failed' })
    if (hasSpend && spend === null) rows.push({ field: 'spend', reason: 'read-failed' })
    rows.sort((a, b) => byString(a.field, b.field) || byString(a.reason, b.reason))
    return {
      schema: SELF_STATE_SCHEMA,
      runtime: { sourceRevision: runtimeRevision, bootedAtMs: Number.isSafeInteger(registry.bootedAtMs) ? registry.bootedAtMs : null },
      edge: { sourceRevision: edgeRevision },
      head: head === null ? null : { ballId: head.ballId, epoch: head.epoch, origin: head.origin === 'host' ? 'host' : 'local' },
      organs,
      staged: stagedOut,
      tools: toolsOut,
      doors: { cloudflare },
      ...(hasShadow ? { nucleusShadow: shadowOut } : {}),
      ...(hasCells ? { cellCount: cellRows === null ? null : cellRows.length, cells: cellsOut } : {}),
      ...(hasJournal ? { cellJournal: journal } : {}),
      ...(hasForged
        ? { forgedCells: forgedRows === null ? null : { count: allForged.length, cells: forgedRows.slice(0, forgedCount) } }
        : {}),
      ...(hasSkills ? { skills: skillRows === null ? null : { count: allSkills.length, kept: skillRows.slice(0, skillCount) } } : {}),
      ...(hasSync ? { threadSync: sync } : {}),
      ...(hasSpend ? { spend } : {}),
      unknown: rows,
    }
  }

  /** The largest count in [0, max] whose answer fits, given the other two counts. */
  const fit = (max: number, make: (count: number) => Json): number => {
    if (bytesOf(make(max)) <= SELF_STATE_RESULT_BYTES) return max
    let low = 0, high = max
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (bytesOf(make(mid)) <= SELF_STATE_RESULT_BYTES) low = mid
      else high = mid - 1
    }
    return low
  }
  const toolMax = tools?.length ?? 0
  // The shadow's mismatch list gives way before any organ row (organs are what this tool is for), then the cell rows
  // (`cellCount` stays, and `x6_cell list` names every cell), then the forged-cell rows (the newest
  // stay; `forgedCells.count` stays, and `x6_cell forged` lists every kept cell), then the kept-skill rows (the newest
  // stay; `skills.count` stays, and the skills tool's `list` names every one).
  const mismatchesFit = fit(shadowMismatches.length, count => build(selection.organs.length, staged.length, toolMax, count))
  const cellsFit = mismatchesFit > 0 ? allCells.length
    : fit(allCells.length, count => build(selection.organs.length, staged.length, toolMax, 0, count))
  const forgedFit = mismatchesFit > 0 || cellsFit > 0 ? allForged.length
    : fit(allForged.length, count => build(selection.organs.length, staged.length, toolMax, 0, 0, count))
  const skillsFit = mismatchesFit > 0 || cellsFit > 0 || forgedFit > 0 ? allSkills.length
    : fit(allSkills.length, count => build(selection.organs.length, staged.length, toolMax, 0, 0, 0, count))
  const organs = mismatchesFit > 0 || cellsFit > 0 || forgedFit > 0 || skillsFit > 0 ? selection.organs.length
    : fit(selection.organs.length, count => build(count, staged.length, toolMax, 0, 0, 0, 0))
  const stagedFit = organs > 0 ? staged.length : fit(staged.length, count => build(0, count, toolMax, 0, 0, 0, 0))
  const toolsFit = organs > 0 || stagedFit > 0 ? toolMax : fit(toolMax, count => build(0, 0, count, 0, 0, 0, 0))
  return build(organs, stagedFit, toolsFit, mismatchesFit, cellsFit, forgedFit, skillsFit)
}

export interface SelfStateDeps {
  /** The worker's own origin; never a tool argument. */
  readonly origin: string | undefined
  /** A read-only snapshot of the loader's registry. */
  readonly registry: () => SelfStateRegistry
  /** Read one VFS file's bytes (throws when it cannot). Used only for the organ store files. */
  readonly readFile: (path: string) => Uint8Array | string
  readonly fetch?: typeof fetch
  /** Let in-flight cell-journal lines settle before the snapshot (bounded; a failure is ignored). */
  readonly settle?: () => Promise<unknown>
}

/** The one request: GET /api/build on her own origin, bounded in time and bytes. Never throws. */
export async function readEdgeBuild(deps: Pick<SelfStateDeps, 'origin' | 'fetch'>): Promise<SelfStateEdge> {
  const origin = deps.origin
  if (!origin || origin === 'null') return { sourceRevision: null, reason: 'unreachable' }
  const doFetch = deps.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, SELF_STATE_EDGE_TIMEOUT_MS)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let answered = false
  try {
    const response = await doFetch(new URL(SELF_STATE_EDGE_PATH, origin).href, { method: 'GET', mode: 'same-origin', credentials: 'same-origin',
      redirect: 'error', cache: 'no-store', signal: controller.signal })
    if (!response.ok || !response.body) return { sourceRevision: null, reason: 'unreachable' }
    answered = true
    if (Number(response.headers.get('content-length')) > SELF_STATE_EDGE_MAX_BYTES) return { sourceRevision: null, reason: 'read-failed' }
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let bytes = 0, text = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > SELF_STATE_EDGE_MAX_BYTES) return { sourceRevision: null, reason: 'read-failed' }
      text += decoder.decode(next.value, { stream: true })
    }
    const body: unknown = JSON.parse(text + decoder.decode())
    if (!record(body) || body.ok !== true || body.schema !== 'aukora.edge-build.v1') return { sourceRevision: null, reason: 'read-failed' }
    if (body.sourceRevision === null) return { sourceRevision: null, reason: 'not-recorded' }
    return typeof body.sourceRevision === 'string' && REVISION.test(body.sourceRevision)
      ? { sourceRevision: body.sourceRevision, reason: null } : { sourceRevision: null, reason: 'read-failed' }
  } catch {
    // A failure before an answer (or a deadline) is `unreachable`; an answer that does not parse is `read-failed`.
    return { sourceRevision: null, reason: answered && !controller.signal.aborted ? 'read-failed' : 'unreachable' }
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) void reader.cancel().catch(() => undefined)
  }
}

/** SHA-256 of one organ store file as it is now, or null when it cannot be read. */
function storeSha(deps: SelfStateDeps, id: string): string | null {
  const path = organStorePath(id)
  if (path === null) return null
  try {
    const bytes = deps.readFile(path)
    return typeof bytes === 'string' || bytes instanceof Uint8Array ? sha256HexSync(bytes) : null
  } catch { return null }
}

/**
 * Read her self-state. In-flight cell-journal lines settle first (at most SELF_STATE_SETTLE_MS), then the registry snapshot
 * and the store reads happen together in one synchronous step, then the one GET. Writes nothing.
 * @param organs - optional list of organ ids to narrow the answer to.
 */
export async function readSelfState(organs: unknown, deps: SelfStateDeps): Promise<Json> {
  const organFilter = parseOrganFilter(organs)
  if (deps.settle) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([deps.settle(), new Promise((resolve) => { timer = setTimeout(resolve, SELF_STATE_SETTLE_MS) })])
    } catch { /* The snapshot then shows what has settled. */ } finally { clearTimeout(timer) }
  }
  const registry = deps.registry()
  const store: Record<string, string | null> = Object.create(null) as Record<string, string | null>
  for (const organ of selectOrgans(registry, organFilter).organs) store[organ.id] = storeSha(deps, organ.id)
  const edge = await readEdgeBuild(deps)
  return projectSelfState({ registry, store, edge, organFilter })
}

/** The tool's definition, registered by the ball runtime beside `x6_capability_index`. */
export function selfStateToolSpec(deps: () => SelfStateDeps) {
  return {
    name: 'x6_self_state',
    description: 'What you are running right now, said from inside, read-only. `runtime.sourceRevision` is the revision baked into '
      + 'the runtime you execute; `edge.sourceRevision` is what your edge says it runs (GET /api/build); `head` is the head your '
      + 'loader holds. For each organ, `sha256Loaded` is the SHA-256 of the exact text your loader evaluated for it in this '
      + 'session, `storeSha256` that of /dsh/home/auma/seed/organs/<id>.js as it is now, and `matchesStore` compares them. '
      + '`staged` lists modules put but not active; `tools` the tools registered in this session. Every null has one row in '
      + '`unknown` saying why. It writes, mounts and runs nothing. Pass `organs` (a list of ids) to narrow it. '
      + '`nucleusShadow` is your shadow consult this session: before each head or organ promotion you stage, and each '
      + 'head your own edit commits (tree_patch), leaves for the edge, your runtime asks your nucleus cell what the '
      + 'Touch ID tier reflex (`reflex`, its digest) says, and shows the answer as `nucleus` beside your result. It '
      + 'decides nothing: the edge\'s classifyTransition alone judges, and the answer is never sent, signed or '
      + 'receipted. `consulted` counts promotions asked about; each is then `agree` (the edge classified it the same), '
      + '`mismatch` (it did not) or `unknown` (no answer within 1.5 s, or the edge said nothing comparable). '
      + '`lastMismatches` keeps the last 8 (the oldest are cut first if the answer would pass 16 KiB): the seven facts, '
      + 'the nucleus outcome, the edge outcome, the time. A mismatch blocks nothing; it is a fact to report '
      + 'with those facts (docs/auma/nucleus.md). '
      + '`cells` is one row per pinned Wasm cell (`cellCount` of them, sorted by name): its pin `sha256`, `bytes`, the `fuel` '
      + 'each call gets, its `ops`, and `loaded`: `verified` only when this session fetched its bytes and they hashed to the '
      + 'pin before compiling, `failed` with a closed `failure`, or `not-loaded` when nothing asked for it yet. '
      + '`cellJournal` is the count and running root of this session\'s cell-call journal (`x6_cell {"action":"journal"}` '
      + 'reads it): a session fact, not a receipt (docs/auma/cells.md). '
      + '`forgedCells` is the cells you forged and keep in your home (`count`, and `cells`: `name`, `sha256`, `bytes`, newest '
      + 'first; `x6_cell {"action":"forged"}` lists them whole): yours, unpinned, outside your head and your record. '
    // ---- KYBERSKILL field begin ----
      + '`skills` is the skills you keep (`count`, and `kept`: `name`, `id`, newest first; `x6_skill {"action":"list"}` '
      + 'lists and checks them): descriptions you can check again, not authority (docs/auma/skills.md). '
    // ---- KYBERSKILL field end ----
      + '`threadSync`, present only while thread sync is switched on, is how your conversations reach your cloud in this '
      + 'page load (docs/auma/thread-sync.md): `mode` is your '
      + 'edge\'s setting (`off`, `pull`, `on`; null before it was read), `role` is this browser (`reader`: it only reads you '
      + 'and changes nothing; `writer`: your one body, copying each new line to your cloud as it is written; `none`), `sent` '
      + 'the whole lines your cloud acknowledged this load, `pending` the whole lines only this browser holds, `lastOkAtMs` '
      + 'the last acknowledged copy and `lastError` the last reason copying waited or stopped. Copy and Join on /rescue '
      + 'remain the fallback. '
      + '`spend` is what your model steps cost in this page life, counted in your worker from the usage each step reports '
      + '(`since`, then `byModel`: `provider`, `model`, `steps`, `input` (uncached), `cacheRead`, `cacheWrite`, `output` '
      + 'tokens, and `usd` from the provider\'s price table, or null where no usage came back or no price is known; never a '
      + 'guess). A reload starts a new count (docs/auma/cost.md).',
    parameters: {
      organs: { type: 'json', description: 'Optional list of organ ids (1 to 64) to narrow the organ list; default all.' },
    },
    async execute(args: Record<string, unknown> | undefined) {
      return await readSelfState(args?.organs, deps())
    },
  }
}

// ---- COST-CHANGE block begin: `spend` (kept in this file, which the loader already imports) ----

/**
 * `spend`: what her model steps cost in this page life, counted in her worker from the per-step usage her
 * harness records on each `assistant/message` event (agent-loop agent.ts: `usage`, the adapter's TokenUsage) and on each
 * `compaction/summary` written by a model call (compaction-basic region.ts: provider, model, usage), and shown read-only
 * by `x6_self_state` as `spend`. Per provider and model: the steps, the compactions, the uncached input, the cache read,
 * the cache write and the output tokens, `usd` summed over the calls priced from the reference table (../claude-prices.ts),
 * and `unpricedCalls`: the calls that came back with no usage (none at all, or all zero: what the older chat-compatible
 * wire logs) or whose model has no price. `usd` is null only when no call of the row was priced. Never a guess. Nothing
 * here is stored or sent; a reload starts a new count.
 */
export interface SpendRow {
  readonly provider: string
  readonly model: string
  /** Model steps (`assistant/message`). */
  readonly steps: number
  /** Compaction summary calls (`compaction/summary` written by a model call). */
  readonly compactions: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  /** Dollars of the priced calls; null when no call of this row could be priced. */
  readonly usd: number | null
  /** Calls not in `usd`: no usage came back (all zero counts as none), or the model has no price. */
  readonly unpricedCalls: number
}

export interface SpendSnapshot {
  /** When this page life's count began (epoch milliseconds). */
  readonly since: number
  readonly byModel: readonly SpendRow[]
}

interface Counting {
  steps: number
  compactions: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** The sum over the priced calls only. */
  usd: number
  pricedCalls: number
  /** Calls (steps or compactions) that came back with no usage, or whose model has no price. */
  unpricedCalls: number
}

const SPEND_NAME = /^[A-Za-z0-9._:/@+-]{1,128}$/
/** At most this many rows are kept (one per provider and model she used in this page life). */
const SPEND_ROWS_MAX = 64

const isSpendRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const spendCount = (value: unknown): number | null => value === undefined ? 0
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

export function createSpendTally(since: number): {
  observe(session: unknown, event: unknown): void
  snapshot(): SpendSnapshot
} {
  const rows = new Map<string, Counting & { provider: string; model: string }>()
  // A failed attempt (`assistant/attempt`) is not counted: its record names no provider or model, and naming one would be a guess.
  return {
    observe(_session, event) {
      try {
        if (!isSpendRecord(event) || !isSpendRecord(event.data)) return
        let provider: unknown, model: unknown
        const compaction = event.type === 'compaction/summary'
        if (event.type === 'assistant/message') {
          const message = event.data.message
          const source = isSpendRecord(message) && isSpendRecord(message.source) ? message.source : undefined
          provider = source?.provider
          model = source?.model
        } else if (compaction) {
          // A summary written without a model call (a template) costs nothing; one written by a model call carries usage.
          if (event.data.llmStreamCall !== true && event.data.usage === undefined) return
          provider = event.data.provider
          model = event.data.model
        } else return
        if (typeof provider !== 'string' || typeof model !== 'string' || !SPEND_NAME.test(provider) || !SPEND_NAME.test(model)) return
        const usage = event.data.usage
        let tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        if (usage !== undefined) {
          if (!isSpendRecord(usage)) return
          const input = spendCount(usage.inputTokens), cacheRead = spendCount(usage.cacheReadTokens)
          const cacheWrite = spendCount(usage.cacheWriteTokens), output = spendCount(usage.outputTokens)
          if (input === null || cacheRead === null || cacheWrite === null || output === null) return
          tokens = { input, cacheRead, cacheWrite, output }
        }
        const key = `${provider}\u0000${model}`
        let row = rows.get(key)
        if (row === undefined) {
          if (rows.size >= SPEND_ROWS_MAX) return
          row = { provider, model, steps: 0, compactions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0,
            pricedCalls: 0, unpricedCalls: 0 }
          rows.set(key, row)
        }
        if (compaction) row.compactions += 1
        else row.steps += 1
        row.input += tokens.input
        row.cacheRead += tokens.cacheRead
        row.cacheWrite += tokens.cacheWrite
        row.output += tokens.output
        const came = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output > 0
        const usd = came ? claudeStepUsd(model, tokens) : null
        if (usd === null) row.unpricedCalls += 1
        else { row.usd += usd; row.pricedCalls += 1 }
      } catch { /* a count never breaks her session */ }
    },
    snapshot() {
      const byModel = [...rows.values()]
        .sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
        .map(row => ({ provider: row.provider, model: row.model, steps: row.steps, compactions: row.compactions, input: row.input,
          cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output,
          usd: row.pricedCalls > 0 ? Math.round(row.usd * 1e6) / 1e6 : null, unpricedCalls: row.unpricedCalls }))
      return { since, byModel }
    },
  }
}

/** `x6_self_state` `spend`: the snapshot checked field by field, or null when it is not that shape. */
export function spendView(value: unknown): SpendSnapshot | null {
  if (!isSpendRecord(value) || !Number.isSafeInteger(value.since)) return null
  if (!Array.isArray(value.byModel) || value.byModel.length > SPEND_ROWS_MAX) return null
  const rows: SpendRow[] = []
  for (const row of value.byModel) {
    if (!isSpendRecord(row) || typeof row.provider !== 'string' || !SPEND_NAME.test(row.provider)) return null
    if (typeof row.model !== 'string' || !SPEND_NAME.test(row.model)) return null
    const numbers = [row.steps, row.compactions, row.input, row.cacheRead, row.cacheWrite, row.output, row.unpricedCalls]
    if (numbers.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return null
    if (row.usd !== null && (typeof row.usd !== 'number' || !Number.isFinite(row.usd) || row.usd < 0)) return null
    rows.push({ provider: row.provider, model: row.model, steps: row.steps as number, compactions: row.compactions as number,
      input: row.input as number, cacheRead: row.cacheRead as number, cacheWrite: row.cacheWrite as number,
      output: row.output as number, usd: row.usd, unpricedCalls: row.unpricedCalls as number })
  }
  return { since: value.since as number, byModel: rows }
}
// ---- COST-CHANGE block end ----
