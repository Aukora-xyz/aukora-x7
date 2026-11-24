/**
 * THE WORK GRAPH AS HER STATE FILE SAYS IT IS — the FALLBACK reading of `auma.superagent` state, used only while the
 * verified status projection (the readout over `auma_superagent` status) refuses her organ's answer — plus the
 * selected ball head and the memory DAG tip. Verification of receipts is never done here; it comes from her own
 * `seed_receipts verify` through the page reader.
 *
 * Three rules hold everywhere in this module:
 *   · A file that could not be read is `null`, never an empty list. "Nothing is running" and "I could not look"
 *     are different answers and the surface renders them differently.
 *   · A field with the wrong shape is dropped and counted, not coerced into something that looks healthy.
 *   · Nothing here verifies anything. Verified receipt facts come only from `seed_receipts verify`.
 *
 * @module work-model
 */

/** Where her coordination state lives in the worker filesystem (`seed-superagent.js`). */
export const SUPERAGENT_STATE_PATH = '/dsh/home/auma/superagent/state.json'
/** The selected ball head (`ball-head` / `HEAD.json`). */
export const BALL_HEAD_PATH = '/dsh/home/balls/HEAD.json'
/** The memory DAG tip pointer (`auma-memory-domain`). */
export const MEMORY_DAG_HEAD_PATH = '/dsh/home/auma/memory/dag/HEAD.json'

/** The executors the North Star names; anything else is shown verbatim as unrecognised. */
export const EXECUTORS = ['browser-worker', 'cloudflare-do', 'mac-limb'] as const
export type Executor = typeof EXECUTORS[number]

export type ReportStatus = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
const REPORT_STATUSES: readonly string[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

export interface MandateView {
  readonly id: string
  readonly title: string
  readonly strength: 'explicit' | 'inferred' | 'unknown'
  /**
   * What the file records about confirmation. `recorded` needs a `confirmedAt` timestamp; `self-declared` is an
   * explicit mandate minted already marked confirmed with no confirmation record; neither is an owner approval.
   */
  readonly confirmation: 'recorded' | 'self-declared' | 'unconfirmed' | 'unknown'
  /** The `confirmedBy` string as written by whoever called the tool — a claim, not an identity. */
  readonly confirmedByClaim: string | null
  readonly stopped: boolean
  readonly paths: readonly string[]
  readonly organs: readonly string[]
  readonly tools: readonly string[]
  readonly budgetSteps: number | null
  readonly expiresAt: number | null
  readonly receiptHash: string | null
  readonly ballId: string | null
  /**
   * Her stored `scope` object, exactly as written (it carries `expiresAt` and `budgetSteps`), or null when absent. An
   * owner signature must cover these bytes: her grant receipt copies this object, and the readout binds to it.
   */
  readonly rawScope: Record<string, unknown> | null
}

export interface TicketView {
  readonly id: string
  readonly mandateId: string | null
  readonly title: string
  readonly state: string
  /** The `stoppedByPerson` flag as written. The organ does not record who set it. */
  readonly stoppedFlag: boolean
}

export interface AssignmentView {
  readonly id: string
  readonly ticketId: string | null
  readonly executor: string
  readonly executorKnown: boolean
  readonly state: string
  readonly lastReport: ReportStatus | null
  readonly lastNote: string | null
  readonly at: number | null
}

export interface AttentionView {
  readonly id: string
  readonly kind: string
  readonly summary: string
  readonly at: number | null
}

export interface OutboxCounts {
  readonly pending: number
  readonly sent: number
  readonly dropped: number
}

/** The whole graph. Lists are only present when the state file was read and parsed. */
export interface WorkGraph {
  readonly mandates: readonly MandateView[]
  readonly tickets: readonly TicketView[]
  readonly assignments: readonly AssignmentView[]
  /** Unresolved attention items only: what is actually waiting on the owner. */
  readonly attention: readonly AttentionView[]
  /** Items the file marks resolved. Resolution is a tool call; nothing here proves the owner resolved them. */
  readonly resolved: readonly AttentionView[]
  readonly outbox: OutboxCounts
  /** Rows whose shape could not be read, by collection. Non-zero means the file says more than this view shows. */
  readonly skipped: number
}

export interface HeadView {
  readonly ballId: string | null
  readonly parentBallId: string | null
  readonly epoch: number | null
}

/** The memory DAG tip as `HEAD.json` writes it. */
export interface DagHeadView {
  readonly heads: readonly string[]
  readonly count: number | null
  readonly updatedAt: number | null
  readonly lastMemoryId: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strs = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const obj = (v: unknown): Record<string, unknown> | null =>
  (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const rows = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

/** A short human summary of an attention item's detail, without inventing anything it does not carry. */
function attentionSummary(kind: string, detail: Record<string, unknown> | null): string {
  if (detail === null) return kind
  const title = str(detail.title)
  const note = str(detail.note)
  const ref = str(detail.mandateId) ?? str(detail.assignmentId) ?? str(detail.ticketId)
  return [title, note, ref].filter((x): x is string => x !== null).join(' · ') || kind
}

/**
 * Read the superagent state file's text into the graph.
 * @param text - the file's complete UTF-8 text.
 * @returns the graph, or null when the text is not a JSON object (a torn or foreign file).
 */
export function parseWorkGraph(text: string): WorkGraph | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const root = obj(raw)
  if (root === null) return null
  let skipped = 0

  const mandates: MandateView[] = []
  for (const row of rows(root.mandates)) {
    const m = obj(row)
    const id = m && str(m.id)
    if (m === null || id === null) { skipped++; continue }
    const scope = obj(m.scope)
    const strength = m.strength === 'explicit' || m.strength === 'inferred' ? m.strength : 'unknown'
    const confirmation = m.confirmed === true
      ? (num(m.confirmedAt) !== null ? 'recorded' : 'self-declared')
      : m.confirmed === false ? 'unconfirmed' : 'unknown'
    mandates.push({
      id,
      title: str(m.title) ?? id,
      strength,
      confirmation,
      confirmedByClaim: str(m.confirmedBy),
      stopped: m.stopped === true,
      paths: strs(scope?.paths),
      organs: strs(scope?.organs),
      tools: strs(scope?.tools),
      budgetSteps: num(m.budgetSteps) ?? num(scope?.budgetSteps),
      expiresAt: num(m.expiresAt) ?? num(scope?.expiresAt),
      receiptHash: str(m.receiptHash),
      ballId: str(m.ballId),
      rawScope: scope,
    })
  }

  const tickets: TicketView[] = []
  for (const row of rows(root.tickets)) {
    const t = obj(row)
    const id = t && str(t.id)
    if (t === null || id === null) { skipped++; continue }
    tickets.push({
      id,
      mandateId: str(t.mandateId),
      title: str(t.title) ?? id,
      state: str(t.state) ?? str(t.status) ?? 'unknown',
      stoppedFlag: t.stoppedByPerson === true,
    })
  }

  const assignments: AssignmentView[] = []
  for (const row of rows(root.assignments)) {
    const a = obj(row)
    const id = a && str(a.id)
    if (a === null || id === null) { skipped++; continue }
    const executor = str(a.executor) ?? 'unknown'
    const reports = rows(a.reports)
    const last = obj(reports[reports.length - 1])
    const lastReport = typeof a.lastReport === 'string' && REPORT_STATUSES.includes(a.lastReport)
      ? (a.lastReport as ReportStatus) : null
    assignments.push({
      id,
      ticketId: str(a.ticketId),
      executor,
      executorKnown: (EXECUTORS as readonly string[]).includes(executor),
      state: str(a.state) ?? 'unknown',
      lastReport,
      lastNote: last === null ? null : str(last.note),
      at: last === null ? num(a.at) : num(last.at),
    })
  }

  const attention: AttentionView[] = []
  const resolved: AttentionView[] = []
  for (const row of rows(root.attention)) {
    const a = obj(row)
    const id = a && str(a.id)
    if (a === null || id === null) { skipped++; continue }
    const kind = str(a.kind) ?? 'attention'
    const view = { id, kind, summary: attentionSummary(kind, obj(a.detail)), at: num(a.at) }
    if (a.resolved === true) resolved.push(view)
    else attention.push(view)
  }

  let pending = 0
  let sent = 0
  let dropped = 0
  for (const row of rows(root.outbox)) {
    const o = obj(row)
    if (o === null) { skipped++; continue }
    if (o.status === 'pending') pending++
    else if (o.status === 'sent') sent++
    else if (o.status === 'dropped') dropped++
    else skipped++
  }

  return { mandates, tickets, assignments, attention, resolved, outbox: { pending, sent, dropped }, skipped }
}

/**
 * Read HEAD.json's text.
 * @returns the head, or null when the text is not a JSON object.
 */
export function parseHead(text: string): HeadView | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const head = obj(raw)
  if (head === null) return null
  return { ballId: str(head.ballId), parentBallId: str(head.parentBallId), epoch: num(head.epoch) }
}

/**
 * Read the memory DAG's HEAD.json text.
 * @returns the tip, or null when the text is not a JSON object.
 */
export function parseDagHead(text: string): DagHeadView | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const head = obj(raw)
  if (head === null) return null
  // Both HEAD shapes seen on main: v0 `{ heads, count, updatedAt: ms }` and v1 `{ headId, totalNodes, updatedAt: ISO }`.
  const iso = str(head.updatedAt)
  const isoMs = iso === null ? null : Date.parse(iso)
  const heads = strs(head.heads)
  const headId = str(head.headId)
  return {
    heads: heads.length === 0 && headId !== null ? [headId] : heads,
    count: num(head.totalNodes) ?? num(head.count),
    updatedAt: num(head.updatedAt) ?? (isoMs !== null && Number.isFinite(isoMs) ? isoMs : null),
    lastMemoryId: str(head.lastMemoryId),
  }
}

/** Count what is active, for the menu badge. Null graph means unknown, not zero. */
export function activeCounts(graph: WorkGraph | null): { running: number; attention: number } | null {
  if (graph === null) return null
  return {
    running: graph.assignments.filter(a => a.state === 'running').length,
    attention: graph.attention.length,
  }
}
