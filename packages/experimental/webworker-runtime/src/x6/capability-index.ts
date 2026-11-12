/**
 * Lane E6: the resident, read-only capability index for `auma-cortex` (VOICE-OMNISCIENCE-BRIEF §0–§3, Tier A).
 *
 * Derived only from what is mounted in memory (registered tool definitions, the live ball's entries and module metas,
 * its epoch and ballId); nothing is hand-authored. The snapshot is deeply frozen, carries a SHA-256 digest over a
 * canonical serialization, and declares `voiceAuthority: 'none', mutating: false`. Reads are zero-I/O: the cache key is
 * the live (epoch, ballId, tool set) read from memory, so a promotion or head change recomputes on the very next read and
 * a stale epoch is never served. A lookup of a name that is not registered answers `NO_SUCH_SURFACE`, never a guess.
 * @module x6/capability-index
 */
import { sha256HexSync } from '../module-system/module-loader.ts'

export const CAPABILITY_INDEX_SCHEMA = 'aukora.capability-index.v1' as const

export interface CapabilityParameter {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly enum?: readonly string[]
}

export interface CapabilityToolSummary {
  readonly name: string
  readonly readOnly: boolean
  readonly mutating: boolean
  readonly description: string
  readonly parameters: ReadonlyArray<CapabilityParameter>
}

export interface CapabilityOrganSummary {
  readonly id: string
  readonly specifier: string
  readonly sha256: string | null
  readonly bytes: number | null
  readonly disabled: boolean
}

export interface CapabilityIndex {
  readonly schema: typeof CAPABILITY_INDEX_SCHEMA
  readonly voiceAuthority: 'none'
  readonly mutating: false
  readonly epoch: number
  readonly ballId: string
  readonly registeredTools: readonly CapabilityToolSummary[]
  readonly organs: readonly CapabilityOrganSummary[]
  readonly counts: { readonly tools: number; readonly readOnlyTools: number; readonly mutatingTools: number; readonly organs: number }
  readonly digest: string
  readonly computedAt: number
}

export interface CapabilitySource {
  readonly epoch: number
  readonly ballId: string
  readonly tools: ReadonlyArray<{ readonly name: string; readonly description?: unknown; readonly parameters?: unknown }>
  readonly entries: Readonly<Record<string, { readonly specifier: string; readonly disabled?: boolean }>>
  readonly modules: Readonly<Record<string, { readonly sha256: string; readonly size: number; readonly specifier?: string }>>
}

/** Verbs whose action can only read. A tool is `readOnly` only when its name or every action it exposes is one of these. */
const READ_VERB = new RegExp('^(list|read|get|status|show|search|inspect|describe|query|lookup|snapshot|view|facts|estate|digest|index|help|verify|check|'
  + 'diff|history|peek|health|whoami|ls|cat|stat|look)$')
/** Names of tools known to be read-only surfaces as a whole. */
const READ_ONLY_TOOLS = new Set(['x6_capability_index', 'x6_browser_estate', 'x6_status', 'x6_facts', 'x6_host_facts'])

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const clip = (value: unknown, max: number): string => typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : ''

function summarizeParameters(parameters: unknown): CapabilityToolSummary['parameters'] {
  if (!record(parameters)) return []
  // JSON-schema shape `{ type: 'object', properties, required }` or the defineTool map `{ name: { type, required, enum } }`.
  const properties = record(parameters.properties) ? parameters.properties : parameters
  const requiredList = Array.isArray(parameters.required) ? parameters.required.filter((item): item is string => typeof item === 'string') : []
  return Object.keys(properties).sort().slice(0, 32).flatMap((name) => {
    const spec = properties[name]
    if (!record(spec)) return []
    const enumValues = Array.isArray(spec.enum) ? spec.enum.filter((item): item is string => typeof item === 'string').slice(0, 24) : undefined
    return [{ name, type: typeof spec.type === 'string' ? spec.type : 'unknown', required: spec.required === true || requiredList.includes(name),
      ...(enumValues && enumValues.length > 0 ? { enum: enumValues } : {}) }]
  })
}

/** Conservative: anything not provably read-only is `mutating`. */
export function classifyToolMutation(name: string, parameters: CapabilityToolSummary['parameters']): { readOnly: boolean; mutating: boolean } {
  if (READ_ONLY_TOOLS.has(name)) return { readOnly: true, mutating: false }
  const action = parameters.find(parameter => parameter.name === 'action' || parameter.name === 'subAction')
  const verbs = action?.enum ?? []
  const tail = name.replace(/^x6_/, '').split(/[_-]/).pop() ?? ''
  const readOnly = verbs.length > 0 ? verbs.every(verb => READ_VERB.test(verb)) : READ_VERB.test(tail)
  return { readOnly, mutating: !readOnly }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** Canonical JSON: sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

/** Build one deeply frozen index from an in-memory source. Pure: no I/O. */
export function buildCapabilityIndex(source: CapabilitySource, computedAt = Date.now()): CapabilityIndex {
  const seen = new Set<string>()
  const registeredTools = source.tools.filter(tool => typeof tool.name === 'string' && !seen.has(tool.name) && seen.add(tool.name))
    .map((tool) => {
      const parameters = summarizeParameters(tool.parameters)
      return { name: tool.name, ...classifyToolMutation(tool.name, parameters), description: clip(tool.description, 240), parameters }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const organs = Object.keys(source.entries).sort().flatMap((id) => {
    const entry = source.entries[id]
    if (entry === undefined) return []
    // Module metas are keyed by SHA-256 (`ball:<sha>` specifiers); a specifier key or a specifier field also resolves.
    const bare = entry.specifier.startsWith('ball:') ? entry.specifier.slice(5) : entry.specifier
    const meta = source.modules[bare] ?? source.modules[entry.specifier]
      ?? Object.values(source.modules).find(item => (item as { specifier?: unknown }).specifier === entry.specifier)
    return [{ id, specifier: entry.specifier, sha256: meta?.sha256 ?? null, bytes: typeof meta?.size === 'number' ? meta.size : null,
      disabled: entry.disabled === true }]
  })
  const body = {
    schema: CAPABILITY_INDEX_SCHEMA,
    voiceAuthority: 'none' as const,
    mutating: false as const,
    epoch: source.epoch,
    ballId: source.ballId,
    registeredTools,
    organs,
    counts: { tools: registeredTools.length, readOnlyTools: registeredTools.filter(tool => tool.readOnly).length,
      mutatingTools: registeredTools.filter(tool => tool.mutating).length, organs: organs.length },
  }
  return deepFreeze({ ...body, digest: sha256HexSync(canonicalJson(body)), computedAt })
}

export type CapabilityLookup =
  | { readonly ok: true; readonly kind: 'tool'; readonly tool: CapabilityToolSummary; readonly epoch: number; readonly ballId: string; readonly digest: string }
  | { readonly ok: true; readonly kind: 'organ'; readonly organ: CapabilityOrganSummary; readonly epoch: number; readonly ballId: string; readonly digest: string }
  | { readonly ok: false; readonly code: 'NO_SUCH_SURFACE'; readonly name: string; readonly message: 'no such surface'; readonly epoch: number; readonly ballId: string; readonly digest: string }

/** Exact-name lookup over one index. Unknown names are never approximated. */
export function lookupCapability(index: CapabilityIndex, name: unknown): CapabilityLookup {
  const key = typeof name === 'string' ? name.trim() : ''
  const at = { epoch: index.epoch, ballId: index.ballId, digest: index.digest }
  const tool = index.registeredTools.find(item => item.name === key)
  if (tool) return Object.freeze({ ok: true as const, kind: 'tool' as const, tool, ...at })
  const organ = index.organs.find(item => item.id === key)
  if (organ) return Object.freeze({ ok: true as const, kind: 'organ' as const, organ, ...at })
  return Object.freeze({ ok: false as const, code: 'NO_SUCH_SURFACE' as const, name: key.slice(0, 128), message: 'no such surface' as const, ...at })
}

/**
 * The resident cache. `read()` derives the cache key from the live in-memory source on every call and recomputes only
 * when it changed (promotion, head adoption, a tool registered or removed), so it is never stale and costs no I/O.
 */
export function createCapabilityIndex(source: () => CapabilitySource, now: () => number = Date.now) {
  let cached: CapabilityIndex | null = null
  let cachedKey = ''
  let recomputes = 0
  const keyOf = (live: CapabilitySource): string =>
    `${live.epoch}\u0000${live.ballId}\u0000${live.tools.map(tool => tool.name).join(',')}\u0000${Object.keys(live.entries).map(id => `${id}=${live.entries[id]?.specifier}:${live.entries[id]?.disabled === true}`).join(',')}`
  const read = (): CapabilityIndex => {
    const live = source()
    const key = keyOf(live)
    if (cached === null || key !== cachedKey) { cached = buildCapabilityIndex(live, now()); cachedKey = key; recomputes += 1 }
    return cached
  }
  return {
    read,
    lookup: (name: unknown): CapabilityLookup => lookupCapability(read(), name),
    invalidate(): void { cached = null; cachedKey = '' },
    stats: () => ({ recomputes }),
  }
}
