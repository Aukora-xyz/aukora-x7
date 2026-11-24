/**
 * The Touch ID tier facts: a head transition, read as the seven facts the shipped tier reflex
 * (`apps/web/public/cells/reflexes/touch-id-tier.json`) decides on. Pure: no I/O, no clock, no authority.
 *
 * It mirrors exactly what `classifyTransition` (server/ball-transition.mjs) looks at, and nothing else: which entries
 * changed (canonical JSON of each own entry), and for a single changed entry whether it is protected (a fixed governance
 * organ, or a `governance` declaration on the entry or its config), whether it was added or removed, whether its module
 * moved between two `ball:<sha>` specifiers, whether it stays enabled on both sides, and whether its config is the same;
 * then whether the manifest id is canonical. That function, run by the edge, alone decides. These facts feed a SHADOW.
 *
 * A fact this module cannot know is never guessed: the whole answer is a closed `FACT_UNKNOWN:<name>` reason.
 * @module x6/nucleus-tier
 */

/** The reflex's variables, in its case-index order (variable 0 is the most significant digit). */
export const NUCLEUS_TIER_SIZES = Object.freeze([3, 2, 2, 2, 2, 2, 2] as const)
export const NUCLEUS_TIER_FACT_NAMES = Object.freeze(['changedOrgans', 'protected', 'missing', 'moduleUpdated',
  'disabledClean', 'configSame', 'canonicalId'] as const)
/** The reflex's outcome bits, bit i = 1 << i (`T1` is bit 8, 256). The names are classifyTransition's own. */
export const NUCLEUS_TIER_OUTCOME_BITS = Object.freeze(['NO_ENTRY_CHANGED', 'MULTI_ORGAN_TRANSITION', 'T2_PROTECTED_ORGAN',
  'ORGAN_ADDED_OR_REMOVED', 'ORGAN_MODULE_UPDATE_REQUIRED', 'ORGAN_DISABLED_STATE_CHANGE', 'ORGAN_CONFIG_CHANGED',
  'NON_CANONICAL_MANIFEST_ID', 'T1'] as const)
export const NUCLEUS_TIER_T1 = 256
/**
 * The fixed governance organs, as classifyTransition holds them (`T2_ONLY_ORGANS`). A copy, so this module stays pure;
 * nucleus-shadow.spec.ts fails if it ever differs from server/ball-transition.mjs or ball-loader.ts.
 */
export const NUCLEUS_TIER_PROTECTED = Object.freeze(['seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura',
  'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map', 'seed-judge', 'gate-judge', 'grant-ledger',
  'aumlok-identity', 'aumlok-keys', 'auma-scion', 'seed-boot', 'auma-kernel'])

export type NucleusTierFactName = typeof NUCLEUS_TIER_FACT_NAMES[number]
export type NucleusTierFacts =
  | { readonly ok: true; readonly facts: readonly number[]; readonly row: number }
  | { readonly ok: false; readonly reason: `FACT_UNKNOWN:${'entries' | 'canonicalId'}` }

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const BALL_SPECIFIER = /^ball:[0-9a-f]{64}$/

/** classifyTransition's canonicalJson: keys sorted, undefined members dropped, undefined array items as null. */
function canonicalJson(value: unknown): string {
  // Only JSON values reach here: undefined members are dropped and undefined items are null, as the edge does.
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const record = value as Json
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}
const declaresGovernance = (entry: unknown): boolean => [entry, isObject(entry) ? entry.config : undefined]
  .some(value => isObject(value) && Object.hasOwn(value, 'governance') && value.governance !== false)
const own = (entries: Json, id: string): unknown => (Object.hasOwn(entries, id) ? entries[id] : undefined)

/** The case index of one fact vector in the reflex's domain. */
export function nucleusTierRow(facts: readonly number[]): number {
  return facts.reduce<number>((row, value, index) => row * (NUCLEUS_TIER_SIZES[index] ?? 1) + value, 0)
}

/**
 * Read one transition as the seven tier facts.
 * @param previous - the head the edge would compare against (its `entries`).
 * @param candidate - the candidate manifest (its `entries`).
 * @param known - `canonicalManifestMatches`: whether the candidate's id is its canonical manifest id, as the edge checks
 *   it. Only a boolean is a known fact; anything else answers `FACT_UNKNOWN:canonicalId`.
 * @returns the facts and their row, or a closed reason.
 */
export function nucleusTierFacts(previous: unknown, candidate: unknown,
  known: { readonly canonicalManifestMatches?: unknown } = {}): NucleusTierFacts {
  const prevEntries = isObject(previous) ? previous.entries : undefined
  const candEntries = isObject(candidate) ? candidate.entries : undefined
  // The edge reads a missing entries map as empty; a candidate or head without one is not a manifest this runtime sends.
  if (!isObject(prevEntries) || !isObject(candEntries)) return { ok: false, reason: 'FACT_UNKNOWN:entries' }
  if (typeof known.canonicalManifestMatches !== 'boolean') return { ok: false, reason: 'FACT_UNKNOWN:canonicalId' }
  const canonical = known.canonicalManifestMatches ? 1 : 0
  let changed: string[]
  try {
    changed = [...new Set([...Object.keys(prevEntries), ...Object.keys(candEntries)])]
      .filter(id => canonicalJson(own(prevEntries, id) ?? null) !== canonicalJson(own(candEntries, id) ?? null))
  } catch (_error) { return { ok: false, reason: 'FACT_UNKNOWN:entries' } }
  const done = (facts: number[]): NucleusTierFacts => ({ ok: true, facts: Object.freeze(facts), row: nucleusTierRow(facts) })
  if (changed.length !== 1) return done([changed.length === 0 ? 0 : 2, 0, 0, 0, 0, 0, canonical])
  const id = changed[0] ?? ''
  const p = own(prevEntries, id), c = own(candEntries, id)
  const isProtected = NUCLEUS_TIER_PROTECTED.includes(id.replace(/:[0-9a-f]{64}$/, '')) || declaresGovernance(p) || declaresGovernance(c) ? 1 : 0
  if (!p || !c) return done([1, isProtected, 1, 0, 0, 0, canonical])
  const pe = p as Json, ce = c as Json
  const moduleUpdated = typeof pe.specifier === 'string' && typeof ce.specifier === 'string' && BALL_SPECIFIER.test(pe.specifier)
    && BALL_SPECIFIER.test(ce.specifier) && pe.specifier !== ce.specifier ? 1 : 0
  const disabledClean = pe.disabled === false && ce.disabled === false ? 1 : 0
  let configSame: number
  try { configSame = canonicalJson(pe.config ?? {}) === canonicalJson(ce.config ?? {}) ? 1 : 0 }
  catch (_error) { return { ok: false, reason: 'FACT_UNKNOWN:entries' } }
  return done([1, isProtected, 0, moduleUpdated, disabledClean, configSame, canonical])
}

/** The names of the outcome bits set in one decision (`T1` alone for 256). */
export function nucleusTierReasons(decision: number): string[] {
  return NUCLEUS_TIER_OUTCOME_BITS.filter((_name, bit) => (decision & (1 << bit)) !== 0)
}

/**
 * The decision an edge classification stands for: T1 with no reasons is 256; T2 is the OR of its reasons' bits.
 * @returns null when the classification is not one this reflex speaks (an unknown reason, T1 with reasons, T2 with none).
 */
export function nucleusTierDecisionOf(tier: unknown, reasons: unknown): number | null {
  if (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== 'string')) return null
  if (tier === 'T1') return reasons.length === 0 ? NUCLEUS_TIER_T1 : null
  if (tier !== 'T2' || reasons.length === 0) return null
  let decision = 0
  for (const reason of reasons as string[]) {
    const bit = NUCLEUS_TIER_OUTCOME_BITS.indexOf(reason as typeof NUCLEUS_TIER_OUTCOME_BITS[number])
    if (bit < 0 || bit === 8) return null
    decision |= 1 << bit
  }
  return decision
}
