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
import { VOICE_SWITCH_TABLE } from './voice-read-only.ts'

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
  readonly actions?: { read: string[]; write: string[] }
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
  readonly counts: {
    readonly tools: number
    readonly readOnlyTools: number
    readonly mutatingTools: number
    readonly organs: number
    readonly mixedTools: number
    readonly readActions: number
    readonly writeActions: number
  }
  readonly digest: string
  readonly computedAt: number
}

export interface CapabilitySource {
  readonly epoch: number
  readonly ballId: string
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description?: unknown
    readonly parameters?: unknown
    readonly readOnly?: unknown
    readonly mutating?: unknown
  }>
  readonly entries: Readonly<Record<string, { readonly specifier: string; readonly disabled?: boolean }>>
  readonly modules: Readonly<Record<string, { readonly sha256: string; readonly size: number; readonly specifier?: string }>>
}

/** Verbs whose action can only read. A tool is `readOnly` only when its name or every action it exposes is one of these. */
const READ_VERB = new RegExp('^(list|read|get|status|show|search|inspect|describe|query|lookup|snapshot|view|facts|estate|digest|index|'
  + 'help|verify|check|diff|history|peek|health|whoami|ls|cat|stat|look|journal|tail|tree|grep|log|forged|info|versions)$')
/** Names of tools known to be read-only surfaces as a whole. */
const READ_ONLY_TOOLS = new Set(['x6_capability_index', 'x6_browser_estate', 'x6_facts', 'x6_host_facts', 'x6_self_state', 'x6_voice_status', 'x6_self_check'])

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const clip = (value: unknown, max: number): string => typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : ''

export function summarizeParameters(parameters: unknown): CapabilityToolSummary['parameters'] {
  if (!record(parameters)) return []
  // JSON-schema shape `{ type: 'object', properties, required }` or the defineTool map `{ name: { type, required, enum } }`.
  const properties = record(parameters.properties) ? parameters.properties : parameters
  const requiredList = Array.isArray(parameters.required) ? parameters.required.filter((item): item is string => typeof item === 'string') : []
  return Object.keys(properties).sort().filter((name, index) => index < 32 || name === 'action' || name === 'subAction').flatMap((name) => {
    const spec = properties[name]
    if (!record(spec)) return []
    const action = name === 'action' || name === 'subAction'
    const values = Array.isArray(spec.enum) ? spec.enum.filter((item): item is string => typeof item === 'string') : undefined
    const enumValues = action ? values : values?.slice(0, 24)
    return [{ name, type: typeof spec.type === 'string' ? spec.type : 'unknown', required: spec.required === true || requiredList.includes(name),
      ...(enumValues && (action || enumValues.length > 0) ? { enum: enumValues } : {}) }]
  })
}

/** Conservative: anything not provably read-only is `mutating`. */
export function classifyToolMutation(
  name: string,
  parameters: CapabilityToolSummary['parameters'],
  declaration: { readonly readOnly?: unknown; readonly mutating?: unknown } = {},
): Pick<CapabilityToolSummary, 'readOnly' | 'mutating' | 'actions'> {
  const row = Object.hasOwn(VOICE_SWITCH_TABLE, name) ? VOICE_SWITCH_TABLE[name] : undefined
  const whole = row?.selector === 'whole' && Object.hasOwn(row.values, '*')
  const action = parameters.filter(parameter => (parameter.name === 'action' || parameter.name === 'subAction') && parameter.enum)
  const verbs = [...new Set(action.flatMap(parameter => parameter.enum ?? []))].sort()
  const actions = action.length > 0 ? { read: [] as string[], write: [] as string[] } : undefined
  if (actions) {
    for (const verb of verbs) {
      // A voice value that holds only for some argument values (argEquals) does not make every call of that action a read.
      const value = row !== undefined && Object.hasOwn(row.values, verb) ? row.values[verb] : undefined
      const read = whole || READ_VERB.test(verb) || (value !== undefined && value.argEquals === undefined)
      actions[read ? 'read' : 'write'].push(verb)
    }
  }
  const tail = name.replace(/^x6_/, '').split(/[_-]/).pop() ?? ''
  const readOnly = READ_ONLY_TOOLS.has(name) || whole || (actions !== undefined ? actions.write.length === 0
    : (declaration.readOnly === true && declaration.mutating !== true) || READ_VERB.test(tail))
  return { readOnly, mutating: !readOnly, ...(actions ? { actions } : {}) }
}

/**
 * What `classifyToolMutation`'s answer for this tool rests on. `actions`: a closed action enum, judged per
 * action. `listed`: a read-only tool named in READ_ONLY_TOOLS, or a whole-tool row of the voice switch table. `declared`:
 * the tool's own definition says `readOnly: true` (and not `mutating`) and it takes no `action`, `subAction`, `kind` or
 * `type`. `name`: ONLY the last segment of its name is a read verb, a heuristic that is never a safety rule. `none`: it is
 * not classed a read at all.
 */
export type CapabilityReadBasis = 'actions' | 'listed' | 'declared' | 'name' | 'none'
export function classifyReadBasis(
  name: string,
  parameters: CapabilityToolSummary['parameters'],
  declaration: { readonly readOnly?: unknown; readonly mutating?: unknown } = {},
): CapabilityReadBasis {
  const row = Object.hasOwn(VOICE_SWITCH_TABLE, name) ? VOICE_SWITCH_TABLE[name] : undefined
  if (READ_ONLY_TOOLS.has(name) || (row?.selector === 'whole' && Object.hasOwn(row.values, '*'))) return 'listed'
  if (parameters.some(parameter => (parameter.name === 'action' || parameter.name === 'subAction') && parameter.enum)) return 'actions'
  // Review fix: a declaration counts for a single-purpose tool only; a tool with an open `action` (no closed enum) may act
  // by an argument the declaration cannot see, as the brief's rule asks (a declaration with a closed action enum).
  if (declaration.readOnly === true && declaration.mutating !== true
    && !parameters.some(parameter => ['action', 'subAction', 'kind', 'type'].includes(parameter.name))) return 'declared'
  return READ_VERB.test(name.replace(/^x6_/, '').split(/[_-]/).pop() ?? '') ? 'name' : 'none'
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
      return { name: tool.name, ...classifyToolMutation(tool.name, parameters, tool), description: clip(tool.description, 240), parameters }
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
      mutatingTools: registeredTools.filter(tool => tool.mutating).length, organs: organs.length,
      mixedTools: registeredTools.filter(tool => tool.actions && tool.actions.read.length > 0 && tool.actions.write.length > 0).length,
      readActions: registeredTools.reduce((count, tool) => count + (tool.actions?.read.length ?? 0), 0),
      writeActions: registeredTools.reduce((count, tool) => count + (tool.actions?.write.length ?? 0), 0) },
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
