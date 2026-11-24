/**
 * Her cells become visible to her, from inside, in this session only.
 *
 * Two facts the cell host (wasm-cells.ts) keeps beside its admission path, adding nothing to it:
 *  - load states: for each pinned cell, what THIS host saw when it loaded it (`verified` only when admitCell accepted
 *    the fetched bytes: the SHA-256 pin before compiling, the memory limits, zero imports, the exact exports), or
 *    `failed` with one closed reason, or nothing yet (`not-loaded`);
 *  - the cell-call journal: after each call to a pinned cell returns, one line with the SHA-256 of the exact request
 *    bytes the host sent and of the answer text it received (never the bytes themselves), totals that are never cut,
 *    the newest CELL_JOURNAL_LINES lines, and a running hash chain over every line since the host was made:
 *    root_0 = SHA-256("aukora.cell-journal.v0"); root_n = SHA-256(UTF-8(hex(root_{n-1}) + canonical(line_n))),
 *    canonical being the cell ABI's canonical JSON (cellCanonicalJson).
 *
 * The root is a SESSION FACT, not a receipt: it is not signed, not stored, not sent, and not in her receipt chain.
 * Two readers of one session read the same root; a new session starts again from root_0. Nothing here is authority.
 * A journal failure never changes a cell call's answer or its deadline: the host records after the answer is ready,
 * inside try/catch, and never awaits the recording.
 * @module x6/cell-journal
 */

/**
 * Who asked the host. `aura-focus` is reserved for an in-runtime aura-focus shadow caller (none exists in this runtime yet).
 * `edge` marks the one line `x6_cell handoff` records for a call the EDGE ran (POST /_host/cell-run), not this
 * host: its pin is the one the edge answered with, or `unanswered`; its digests are of the exact body sent there and
 * the answer text read back. Only the host's `noteEdgeCall` writes it; no other caller can claim it.
 */
export type CellCaller = 'x6_cell' | 'nucleus-shadow' | 'aura-focus' | 'edge' | 'other'
export const CELL_CALLERS: readonly CellCaller[] = Object.freeze(['x6_cell', 'nucleus-shadow', 'aura-focus', 'edge', 'other'])
export type CellCallStatus = 'ok' | 'refused' | 'trap' | 'fuel' | 'timeout'
export const CELL_CALL_STATUSES: readonly CellCallStatus[] = Object.freeze(['ok', 'refused', 'trap', 'fuel', 'timeout'])
/** Why a load was refused. The first four are the admission rules; `admission-failed` is any other refusal of the bytes. */
export type CellLoadFailure = 'pin-mismatch' | 'imports-present' | 'memory-over-cap' | 'fetch-failed' | 'admission-failed'
export const CELL_LOAD_FAILURES: readonly CellLoadFailure[] = Object.freeze(['pin-mismatch', 'imports-present', 'memory-over-cap', 'fetch-failed', 'admission-failed'])
export type CellLoadState = { readonly state: 'verified' } | { readonly state: 'failed'; readonly reason: CellLoadFailure }

/** The journal's seed text. */
export const CELL_JOURNAL_SEED = 'aukora.cell-journal.v0'
/** root_0: SHA-256 of the seed's UTF-8 bytes (cell-journal.spec.ts recomputes it). */
export const CELL_JOURNAL_ROOT_0 = '457dae6b77f3f168d86d9412e7128423fe2de7dfdc65ba4268df25409baf120e'
/** Lines kept in memory (the newest; totals are never cut). */
export const CELL_JOURNAL_LINES = 32

/** One pinned cell as her self-state shows it. `failure` is present only when `loaded` is `failed`. */
export interface CellRow {
  readonly cell: string
  readonly sha256: string
  readonly bytes: number | null
  readonly fuel: number
  readonly ops: readonly string[]
  readonly loaded: 'not-loaded' | 'verified' | 'failed'
  readonly failure?: CellLoadFailure
}

/** One journal line. Digests are lower-case hex SHA-256; null when the host had no such bytes for that call. */
export interface CellJournalLine {
  readonly n: number
  readonly cell: string
  readonly op: string
  /** Lower-case 64-hex SHA-256; only caller `edge` may use exactly `unanswered` when no pin was answered. */
  readonly pin: string
  readonly inputSha256: string | null
  readonly outputSha256: string | null
  readonly status: CellCallStatus
  readonly fuelUsed: number | null
  readonly ms: number
  readonly caller: CellCaller
}

/** What one finished call hands the journal: the exact request bytes sent and the answer text received, when there were any. */
export interface CellCallRecord {
  readonly cell: string
  readonly op: string
  /** Lower-case 64-hex SHA-256; only caller `edge` may use exactly `unanswered` when no pin was answered. */
  readonly pin: string
  readonly request: Uint8Array | null
  readonly answer: string | null
  /** The answer's code (null when ok). */
  readonly code: string | null
  readonly fuelUsed: number | null
  readonly ms: number
  readonly caller: CellCaller
}

export interface CellJournalTotals {
  readonly byCell: Readonly<Record<string, number>>
  readonly byStatus: Readonly<Record<CellCallStatus, number>>
  /** Lines recorded (each one is in the root). */
  readonly calls: number
  /** Calls whose line could not be recorded (hashing failed): in no line and not in the root. */
  readonly lost: number
}

export interface CellJournalRead {
  readonly ok: true
  readonly totals: CellJournalTotals
  /** Newest first, at most CELL_JOURNAL_LINES. */
  readonly lines: readonly CellJournalLine[]
  readonly rootSha256: string
}

export interface CellJournalSummary { readonly calls: number; readonly rootSha256: string }

export interface CellJournal {
  /** Queue one finished call. Returns at once; the hashing runs later, in call order. */
  record(call: CellCallRecord): void
  /** Every queued line settled, then the totals, the newest lines and the root. */
  read(): Promise<CellJournalRead>
  /** The settled count and root, read synchronously (what `x6_self_state` shows). */
  summary(): CellJournalSummary
}

const encoder = new TextEncoder()
const toHex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const webCryptoSha256 = async (bytes: Uint8Array): Promise<string> =>
  toHex(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))
const SHA = /^[a-f0-9]{64}$/

/** The closed status of one answer: the worker's own trap, fuel and deadline codes; any other code is a refusal. */
export function cellCallStatus(code: string | null): CellCallStatus {
  if (code === null) return 'ok'
  if (code === 'TRAP') return 'trap'
  if (code === 'FUEL') return 'fuel'
  if (code === 'TIMEOUT') return 'timeout'
  return 'refused'
}

/**
 * The closed reason for a refused load.
 * @param code - the host's CellError code, or null for any other error.
 * @param fetching - true while the bytes were not yet in hand.
 */
export function cellLoadFailure(code: string | null, fetching: boolean): CellLoadFailure {
  if (code === 'MODULE_HASH' || code === 'MODULE_BOUND') return 'pin-mismatch'
  if (code === 'MODULE_IMPORTS' || code === 'MODULE_MEMORY_IMPORTED') return 'imports-present'
  if (code === 'MODULE_MEMORY_LIMIT' || code === 'MODULE_MEMORY_UNBOUNDED') return 'memory-over-cap'
  if (fetching || code === 'ORIGIN_UNAVAILABLE' || code === 'MODULE_UNAVAILABLE') return 'fetch-failed'
  return 'admission-failed'
}

/**
 * Make one session's journal.
 * @param deps - `canonical`: the cell ABI's canonical JSON (the host passes cellCanonicalJson); `sha256`: bytes to hex
 *   (WebCrypto by default; tests pass one that fails).
 */
export function createCellJournal(deps: {
  readonly canonical: (value: unknown) => string
  readonly sha256?: (bytes: Uint8Array) => Promise<string>
}): CellJournal {
  const sha256 = deps.sha256 ?? webCryptoSha256
  const byCell = new Map<string, number>()
  const byStatus: Record<CellCallStatus, number> = { ok: 0, refused: 0, trap: 0, fuel: 0, timeout: 0 }
  const lines: CellJournalLine[] = []
  let calls = 0, lost = 0, next = 0
  let root = CELL_JOURNAL_ROOT_0
  let tail: Promise<void> = Promise.resolve()

  const digest = async (bytes: Uint8Array): Promise<string> => {
    const hex = await sha256(bytes)
    if (typeof hex !== 'string' || !SHA.test(hex)) throw new Error('CELL_JOURNAL_DIGEST')
    return hex
  }
  const step = async (n: number, call: CellCallRecord): Promise<void> => {
    const line: CellJournalLine = {
      n, cell: call.cell, op: call.op, pin: call.pin,
      inputSha256: call.request === null ? null : await digest(call.request),
      outputSha256: call.answer === null ? null : await digest(encoder.encode(call.answer)),
      status: cellCallStatus(call.code),
      fuelUsed: Number.isSafeInteger(call.fuelUsed) ? call.fuelUsed : null,
      ms: Number.isFinite(call.ms) ? Math.max(0, Math.round(call.ms)) : 0,
      caller: CELL_CALLERS.includes(call.caller) ? call.caller : 'other',
    }
    // Every state change happens after the last await: a failed line changes nothing but `lost`.
    const nextRoot = await digest(encoder.encode(`${root}${deps.canonical(line)}`))
    root = nextRoot
    calls += 1
    byCell.set(line.cell, (byCell.get(line.cell) ?? 0) + 1)
    byStatus[line.status] += 1
    lines.push(line)
    if (lines.length > CELL_JOURNAL_LINES) lines.shift()
  }

  return {
    record(call) {
      next += 1
      const n = next
      tail = tail.then(() => step(n, call)).catch(() => { lost += 1 })
    },
    async read() {
      await tail
      return {
        ok: true,
        totals: {
          byCell: Object.fromEntries([...byCell.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
          byStatus: { ...byStatus },
          calls,
          lost,
        },
        lines: [...lines].reverse(),
        rootSha256: root,
      }
    },
    summary: () => ({ calls, rootSha256: root }),
  }
}
