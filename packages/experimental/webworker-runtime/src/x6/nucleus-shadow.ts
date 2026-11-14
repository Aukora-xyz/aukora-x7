/**
 * The shadow consult: before a head or organ promotion she stages leaves for the edge, her runtime asks
 * her pinned `nucleus` cell what the shipped Touch ID tier reflex says about it, and later tallies that answer against
 * the classification the edge returns. It DECIDES NOTHING: the edge's `classifyTransition` alone judges, and no byte
 * sent to the edge, nothing signed and no receipt carries the answer. It is only shown to her, beside her own result.
 *
 * It can never hurt the real path: `consult` never rejects, runs inside a 1,500 ms budget, and any failure, refusal or
 * timeout is `{ consult: null, reason }` with a closed reason. The reflex file is fetched and SHA-256 checked against the
 * pin below once per session (a read that failed is tried again at the next consult; a file that arrived and is not the
 * pinned reflex is refused for the session); the cell is the one pinned in CELL_PINS, run through her one cell host.
 * @module x6/nucleus-shadow
 */
import { sha256HexSync } from '../module-system/module-loader.ts'
import type { CellAnswer } from './wasm-cells.ts'
import { NUCLEUS_TIER_FACT_NAMES, NUCLEUS_TIER_SIZES, nucleusTierDecisionOf, nucleusTierFacts, nucleusTierReasons } from './nucleus-tier.ts'

/** Where the shipped reflex is served on her own origin (apps/web/public/cells/reflexes/touch-id-tier.json). */
export const TOUCH_ID_TIER_REFLEX_PATH = '/cells/reflexes/touch-id-tier.json'
/** SHA-256 of the shipped reflex FILE, byte for byte (its canonical JSON and one newline). */
export const TOUCH_ID_TIER_REFLEX_SHA256 = 'b76f54837eb4d36dfbec83d6b118f00e762dd5394ebaac25757b4303394be903'
/** The reflex's own digest as the cell names it (SHA-256 of its canonical JSON, the file without its last newline). */
export const TOUCH_ID_TIER_REFLEX_DIGEST = '5a46610629c7d61df5adfb5aaf0ecb1c7b4f94e3a1f89023a95102efe41596f6'
export const TOUCH_ID_TIER_REFLEX_MAX_BYTES = 16 * 1024
export const NUCLEUS_CONSULT_BUDGET_MS = 1500
export const NUCLEUS_SHADOW_MISMATCHES_KEPT = 8

/** What she sees beside her local result. Never sent, signed or receipted. */
export type NucleusConsultAnswer =
  | {
    readonly decision: number
    readonly reasons: readonly string[]
    readonly escalate: 0 | 1
    readonly reflex: string
    readonly row: number
  }
  | { readonly consult: null; readonly reason: string }

export interface NucleusConsultRecord {
  readonly nucleus: NucleusConsultAnswer
  /** The seven tier facts that were asked, or null when they could not be read. */
  readonly facts: readonly number[] | null
}

export interface NucleusShadowMismatch {
  readonly at: number
  readonly facts: Readonly<Record<string, number>>
  readonly nucleus: { readonly decision: number; readonly reasons: readonly string[]; readonly escalate: 0 | 1 }
  readonly edge: { readonly tier: string; readonly reasons: readonly string[] }
}

/** The session's tally, shown by `x6_self_state` as `nucleusShadow`. */
export interface NucleusShadowTally {
  readonly reflex: string
  readonly consulted: number
  readonly agree: number
  readonly mismatch: number
  readonly unknown: number
  readonly lastMismatches: readonly NucleusShadowMismatch[]
}

/** The edge's own classification of the promotion, when its answer carries one. */
export interface EdgeTierOutcome { readonly tier: unknown; readonly t2Reasons: unknown }

export interface NucleusShadowDeps {
  /**
   * The shipped reflex file's bytes (a same-origin read). May throw. Called once per session, and again at a later
   * consult only after it threw (a network drop is not cached; a wrong or invalid file is).
   */
  readonly loadReflex: () => Promise<Uint8Array | string>
  /** Her cell host. */
  readonly cells: () => { invoke(cell: string, op: string, input?: unknown): Promise<CellAnswer> }
  readonly now: () => number
  readonly budgetMs?: number
}

export interface NucleusShadow {
  /** Ask the nucleus about one transition. Never rejects; at most the budget long. */
  consult(previous: unknown, candidate: unknown, known: { readonly canonicalManifestMatches?: unknown }): Promise<NucleusConsultRecord>
  /** Count one consult against what the edge said (null: nothing comparable). Once per record; later calls are ignored. */
  settle(record: NucleusConsultRecord, edge: EdgeTierOutcome | null): 'agree' | 'mismatch' | 'unknown' | 'already-settled'
  snapshot(): NucleusShadowTally
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const nothing = (reason: string): NucleusConsultAnswer => Object.freeze({ consult: null, reason })
const CODE = /^[A-Z][A-Z0-9_]{1,63}/

/** The shipped reflex, checked: exact file digest, then a table over the tier domain. */
function admitReflex(bytes: Uint8Array | string): { ok: true; reflex: Json } | { ok: false; reason: string } {
  const length = typeof bytes === 'string' ? new TextEncoder().encode(bytes).byteLength : bytes.byteLength
  if (length > TOUCH_ID_TIER_REFLEX_MAX_BYTES || sha256HexSync(bytes) !== TOUCH_ID_TIER_REFLEX_SHA256) return { ok: false, reason: 'REFLEX_DIGEST_MISMATCH' }
  try {
    const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const reflex: unknown = JSON.parse(text)
    if (!isObject(reflex) || reflex.kind !== 'table' || !Array.isArray(reflex.sizes)
      || reflex.sizes.join(',') !== NUCLEUS_TIER_SIZES.join(',')) return { ok: false, reason: 'REFLEX_INVALID' }
    return { ok: true, reflex }
  } catch (_error) { return { ok: false, reason: 'REFLEX_INVALID' } }
}

/**
 * One session's shadow: the reflex loaded once, the tally in memory.
 * @param deps - the reflex reader, her cell host, a clock and (tests only) a budget.
 */
export function createNucleusShadow(deps: NucleusShadowDeps): NucleusShadow {
  const budgetMs = deps.budgetMs ?? NUCLEUS_CONSULT_BUDGET_MS
  let reflexLoad: Promise<{ ok: true; reflex: Json } | { ok: false; reason: string }> | null = null
  const reflex = () => {
    if (reflexLoad !== null) return reflexLoad
    const load: Promise<{ ok: true; reflex: Json } | { ok: false; reason: string }> = Promise.resolve().then(() => deps.loadReflex())
      .then(admitReflex, () => {
        // A read that failed (network, timeout, origin) is not this session's answer: the next consult reads again.
        // Only a file that arrived and is not the pinned reflex (REFLEX_DIGEST_MISMATCH, REFLEX_INVALID) stays refused.
        if (reflexLoad === load) reflexLoad = null
        return { ok: false as const, reason: 'REFLEX_UNAVAILABLE' }
      })
    reflexLoad = load
    return load
  }
  const tally = { consulted: 0, agree: 0, mismatch: 0, unknown: 0 }
  const lastMismatches: NucleusShadowMismatch[] = []
  const settled = new WeakSet<NucleusConsultRecord>()

  const ask = async (facts: readonly number[], row: number): Promise<NucleusConsultAnswer> => {
    const loaded = await reflex()
    if (!loaded.ok) return nothing(loaded.reason)
    let answer: CellAnswer
    try { answer = await deps.cells().invoke('nucleus', 'reflex.run', { input: [...facts], reflex: loaded.reflex }) }
    catch (_error) { return nothing('CELL_FAILED') }
    if (!isObject(answer) || !answer.ok) {
      const code = isObject(answer) && typeof answer.code === 'string' ? CODE.exec(answer.code)?.[0] : undefined
      return nothing(code ? `CELL_REFUSED:${code}` : 'CELL_REFUSED')
    }
    const result = answer.result
    if (!isObject(result) || !Number.isSafeInteger(result.decision) || (result.decision as number) < 0 || (result.decision as number) > 511
      || (result.escalate !== 0 && result.escalate !== 1) || result.row !== row) return nothing('ANSWER_INVALID')
    if (result.reflex !== TOUCH_ID_TIER_REFLEX_DIGEST) return nothing('REFLEX_DIGEST_MISMATCH')
    const decision = result.decision as number
    return Object.freeze({ decision, reasons: Object.freeze(nucleusTierReasons(decision)), escalate: result.escalate,
      reflex: TOUCH_ID_TIER_REFLEX_DIGEST, row })
  }

  return {
    async consult(previous, candidate, known) {
      try {
        const tier = nucleusTierFacts(previous, candidate, known)
        if (!tier.ok) return Object.freeze({ nucleus: nothing(tier.reason), facts: null })
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<NucleusConsultAnswer>((resolve) => { timer = setTimeout(() => { resolve(nothing('TIMEOUT')) }, budgetMs) })
        try {
          const nucleus = await Promise.race([ask(tier.facts, tier.row).catch(() => nothing('CONSULT_FAILED')), timeout])
          return Object.freeze({ nucleus, facts: tier.facts })
        } finally { clearTimeout(timer) }
      } catch (_error) {
        return Object.freeze({ nucleus: nothing('CONSULT_FAILED'), facts: null })
      }
    },
    settle(record, edge) {
      if (settled.has(record)) return 'already-settled'
      settled.add(record)
      tally.consulted += 1
      const nucleus = record.nucleus
      const edgeDecision = edge === null ? null : nucleusTierDecisionOf(edge.tier, edge.t2Reasons)
      if ('consult' in nucleus || edge === null || edgeDecision === null || record.facts === null) { tally.unknown += 1; return 'unknown' }
      if (nucleus.decision === edgeDecision) { tally.agree += 1; return 'agree' }
      tally.mismatch += 1
      const facts = record.facts
      lastMismatches.push(Object.freeze({
        at: deps.now(),
        facts: Object.freeze(Object.fromEntries(NUCLEUS_TIER_FACT_NAMES.map((name, index) => [name, facts[index] ?? 0]))),
        nucleus: Object.freeze({ decision: nucleus.decision, reasons: nucleus.reasons, escalate: nucleus.escalate }),
        edge: Object.freeze({ tier: String(edge.tier), reasons: Object.freeze(nucleusTierReasons(edgeDecision)) }),
      }))
      const over = lastMismatches.length - NUCLEUS_SHADOW_MISMATCHES_KEPT
      if (over > 0) lastMismatches.splice(0, over)
      return 'mismatch'
    },
    snapshot() {
      return { reflex: TOUCH_ID_TIER_REFLEX_DIGEST, ...tally,
        lastMismatches: lastMismatches.map(item => ({ ...item, facts: { ...item.facts },
          nucleus: { ...item.nucleus, reasons: [...item.nucleus.reasons] }, edge: { ...item.edge, reasons: [...item.edge.reasons] } })) }
    },
  }
}
