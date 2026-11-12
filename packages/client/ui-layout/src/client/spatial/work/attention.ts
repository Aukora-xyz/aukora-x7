/**
 * WHAT IS WAITING ON THE OWNER, ONCE EACH, UNDER A HEADING HE CAN READ.
 *
 * Two pure decisions, kept here so they can be driven with her real rows:
 *
 *   · ONE ROW PER FACT. Her organ reports a blocked assignment (`assignment-blocked`) and a stale heartbeat
 *     (`stale-heartbeat`) itself; the page readout also derives a `blocked` row from the same assignment's report and a
 *     heartbeat row from the same assignment's heartbeat age. Both say one thing, so the organ's own row stays (it carries
 *     her words) and the derived row folds into it as "says the same". A derived row whose assignment the organ did NOT
 *     report stays on its own: then it is the only notice.
 *   · THE HEADING FOLLOWS THE MANDATE'S STRENGTH. Until her organ tags explicit refusals with their own kind, both
 *     strengths arrive as `inferred-mandate-confirmation`. When the row names a mandate this view shows, the heading uses
 *     that mandate's actual strength; when it names none, the neutral "mandate waits for confirmation" is used. A kind
 *     the label table does not know is shown verbatim.
 *
 * @module attention
 */

/** One attention row as the Work view holds it. */
export interface AttentionRow {
  readonly id: string
  readonly kind: string
  readonly text: string
  /** Where it came from: her organ's status, a readout derivation, or her state file (fallback). */
  readonly source: 'status' | 'assignment-report' | 'heartbeat' | 'state-file'
}

/** A row after folding: what to show, and which derived notices said the same thing. */
export interface ShownAttention extends AttentionRow {
  readonly alsoFrom: readonly ('assignment-report' | 'heartbeat')[]
}

const HEARTBEAT_KINDS: ReadonlySet<string> = new Set(['stale-heartbeat', 'heartbeat-missing', 'heartbeat-invalid', 'heartbeat-future'])
const BLOCKED_KINDS: ReadonlySet<string> = new Set(['assignment-blocked', 'blocked'])
const ASSIGNMENT_ID = /\basg_[0-9a-zA-Z]+\b/g

/** The assignment a derived row is about: the readout keys them `assignment-report:<id>` and `heartbeat:<id>`. */
function derivedAssignment(row: AttentionRow): string | null {
  const at = row.id.indexOf(':')
  return at > 0 && at < row.id.length - 1 ? row.id.slice(at + 1) : null
}

/** The assignment ids an organ row names in its text (`detail.assignmentId` is rendered into the text). */
function namedAssignments(row: AttentionRow): ReadonlySet<string> {
  return new Set(row.text.match(ASSIGNMENT_ID) ?? [])
}

/**
 * Fold derived rows into the organ rows that already say the same thing.
 * @param rows - attention rows in the order the readout gave them.
 * @returns each fact once, organ rows first in their own order, then unmatched derived rows.
 */
export function foldAttention(rows: readonly AttentionRow[]): ShownAttention[] {
  const own = rows.filter(r => r.source === 'status' || r.source === 'state-file')
  const shown: ShownAttention[] = own.map(r => ({ ...r, alsoFrom: [] }))
  const named = own.map(namedAssignments)
  for (const row of rows) {
    if (row.source !== 'assignment-report' && row.source !== 'heartbeat') continue
    const assignment = derivedAssignment(row)
    const family = row.source === 'heartbeat' ? HEARTBEAT_KINDS : BLOCKED_KINDS
    const at = assignment === null
      ? -1
      : own.findIndex((o, k) => family.has(o.kind) && (named[k]?.has(assignment) ?? false))
    const target = at >= 0 ? shown[at] : undefined
    if (target !== undefined) {
      if (!target.alsoFrom.includes(row.source)) shown[at] = { ...target, alsoFrom: [...target.alsoFrom, row.source] }
    } else {
      shown.push({ ...row, alsoFrom: [] })
    }
  }
  return shown
}

/** The label key for one row's heading, or null when the kind is unknown and must be shown verbatim. */
export function headingKey(
  row: Pick<AttentionRow, 'kind' | 'text'>,
  mandates: readonly { readonly id: string; readonly strength: string }[],
): string | null {
  if (row.kind === 'inferred-mandate-confirmation' || row.kind === 'explicit-mandate-confirmation') {
    const named = mandates.find(m => row.text.includes(m.id))
    if (named?.strength === 'explicit') return 'kind.explicit-mandate-confirmation'
    if (named?.strength === 'inferred') return 'kind.inferred-mandate-confirmation'
    return row.kind === 'explicit-mandate-confirmation' ? 'kind.explicit-mandate-confirmation' : 'kind.mandate-confirmation'
  }
  return KNOWN_KINDS.has(row.kind) ? `kind.${row.kind}` : null
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  'assignment-blocked', 'assignment-waiting', 'blocked', 'stale-heartbeat', 'heartbeat-missing', 'heartbeat-invalid',
  'heartbeat-future', 'question', 'diff-review', 'promotion-review', 'owner-confirmation-refused',
])
