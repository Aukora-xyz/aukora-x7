/**
 * `x6_tools`, her own tools, tier T1 (docs/auma/tools.md; her design "Tools are mine", 2026-11-14).
 *
 * A tool is an `aukora.tool.v1` manifest: a name, read-only actions, what it requires, a handler and its own tests. She
 * proposes it, the host qualifies it (runs every case through the sealed cell and checks the tier), the owner's session
 * mounts it, and it is registered as its own tool `x6t_<name>`. This module holds the whole policy; ball-loader.ts only
 * wires it to her cell host, her storage and the tool registry.
 *
 * The decisions for this tool:
 *  - D1. The handler is a sealed cell she already has: a kept forged cell (by its SHA-256, `x6_cell forge`) or a pinned
 *    cell (by name), plus the op and a fixed program. A zero-import Wasm cell reaches nothing: the sandbox is the wall.
 *    JavaScript handlers (her `ball:<sha256>`) wait for a real sandbox: refused TOOL_TIER_NOT_OPEN.
 *  - D2. Tier T1 only: every action `readOnly: true`, authority `A`; `requires.services` empty or `["home-read"]` with
 *    explicit path patterns; no secrets; no network. Anything else is TOOL_TIER_NOT_OPEN with the tier it would need.
 *  - D3. Mount of a T1 tool needs the owner's session (no passkey tap): it is reversible and adds no new act. The answer
 *    carries the machine-made capability diff, which is also kept in the mounted record.
 *  - D4. This file is closed to proposals (deploy/ci/frozen-paths.mjs).
 *
 * Storage (RUNTIME_WRITE_SET `tool-registry-store`, class continuity):
 *  - `/dsh/home/tools/proposals/<name>/<sha256>.json`: a proposal, the canonical bytes of `{ manifest, notes }`, named by
 *    their own SHA-256. Proposing mounts nothing.
 *  - `/dsh/home/tools/mounted/<name>.json`: one mounted tool, with its qualification id and its capability diff.
 * No tool mounted here can write, reach the network, read a secret, call a model or mount another tool: its handler is a
 * zero-import cell, and the only bytes it sees are the caller's input and the home files the host read for it.
 * @module x6/tool-registry
 */
import { sha256HexSync } from '../module-system/module-loader.ts'
import { cellCanonicalJson } from './wasm-cells.ts'
import { estateRedaction } from './browser-estate.ts'
import { resolveVoicePath } from './voice-read-only.ts'

export const TOOL_SCHEMA = 'aukora.tool.v1'
export const TOOL_MOUNT_SCHEMA = 'aukora.tool-mount.v1'
/** The host's own suite version: part of every qualification id, so a change to the host's checks makes old ids stale. */
export const TOOL_HOST_SUITE = 'aukora.tool-host-suite.t1.v1'
export const TOOLS_DIR = '/dsh/home/tools'
export const TOOL_PROPOSALS_DIR = `${TOOLS_DIR}/proposals`
export const TOOL_MOUNTED_DIR = `${TOOLS_DIR}/mounted`
export const TOOL_PREFIX = 'x6t_'
export const TOOL_NAME = /^[a-z][a-z0-9-]{1,30}$/
export const TOOL_MANIFEST_MAX_BYTES = 64 * 1024
export const TOOL_NOTES_MAX_CHARS = 4096
export const TOOL_MAX_ACTIONS = 16
export const TOOL_MAX_CASES = 32
export const TOOLS_MOUNTED_MAX = 64
/** One stored proposal (`{ manifest, notes }`, canonical): the manifest bound plus room for the notes. */
export const TOOL_PROPOSAL_MAX_BYTES = 96 * 1024
/** Open (unmounted) proposals kept at once, all names; one more is TOOL_PROPOSALS_FULL. With the 64 mounted ones' own
 * proposals, her tool store holds at most 128 proposals (12 MiB). Whether her mirrored home carries /dsh/home/tools/ (so
 * a tool follows her to another browser) is UNVERIFIED: no mirror test names this folder. */
export const TOOL_PROPOSALS_MAX = 64
/** `home-read`: bytes the host reads for one call (all files together), and how many files. */
export const TOOL_HOME_READ_MAX_BYTES = 256 * 1024
export const TOOL_HOME_READ_MAX_FILES = 16
export const TOOL_READ_PATTERNS_MAX = 16
/** The root every `home-read` pattern must sit under. */
export const TOOL_HOME_READ_ROOT = '/dsh/home/auma/'
export const TOOL_SERVICES_T1: readonly string[] = Object.freeze(['home-read'])
export const TOOL_ACTIONS: readonly string[] = Object.freeze(['propose', 'qualify', 'mount', 'list', 'unmount'])
/** The verbs that read only (the rest write her home: propose, mount, unmount). */
export const TOOL_READ_ACTIONS: readonly string[] = Object.freeze(['list', 'qualify'])

const SHA = /^[a-f0-9]{64}$/
const ACTION_NAME = /^[a-z][a-z0-9_]{0,31}$/
const CASE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const OP = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_.]{0,63})?$/
const PROPOSAL_FILE = /^([a-f0-9]{64})\.json$/
const MOUNTED_FILE = /^([a-z][a-z0-9-]{1,30})\.json$/
const MANIFEST_KEYS = new Set(['schema', 'name', 'version', 'description', 'actions', 'requires', 'handler', 'tests', 'author', 'lineage'])
const REQUIRES_KEYS = new Set(['services', 'secrets', 'network', 'reads'])
const ACTION_KEYS = new Set(['description', 'input', 'output', 'readOnly', 'authority'])
const HANDLER_KEYS = new Set(['cell', 'pin', 'op', 'program'])
const CASE_KEYS = new Set(['name', 'action', 'input', 'files', 'expect'])
/** Keys the host itself puts in a cell's input; a program or a caller's input may not name them. */
const HOST_INPUT_KEYS = new Set(['files', 'action'])

type Json = Record<string, unknown>
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const encoder = new TextEncoder()
const sha256 = (text: string): string => sha256HexSync(encoder.encode(text))

/** One action of a manifest. */
export interface ToolAction {
  readonly description?: string
  readonly input?: unknown
  readonly output?: unknown
  /** T1 admits only `true`; a stored manifest is read back as it is, so the type says what the bytes can hold. */
  readonly readOnly: boolean
  readonly authority: string
}
/** The handler: a pinned cell by name, or a kept forged cell by the SHA-256 of its admitted bytes. */
export type ToolHandler =
  | { readonly pin: string; readonly op: string; readonly program?: Json }
  | { readonly cell: string; readonly op: string; readonly program?: Json }
/** What a case expects: an exact result, a result that must differ from a value, or a refusal (any code, or one). */
export type ToolExpect = { readonly ok: true; readonly result: unknown } | { readonly ok: true; readonly not: unknown }
  | { readonly ok: false; readonly code?: string }
export interface ToolCase {
  readonly name: string
  readonly action?: string
  readonly input?: Json
  /** For a `home-read` tool: fixture files `{ path, text }` fed in place of a real read (each path still checked). */
  readonly files?: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly expect: ToolExpect
}
export interface ToolRequires {
  readonly services: readonly string[]
  readonly secrets?: readonly string[]
  readonly network?: boolean
  readonly reads?: readonly string[]
}
export interface ToolManifest {
  readonly schema: typeof TOOL_SCHEMA
  readonly name: string
  readonly version: string
  readonly description: string
  readonly actions: Readonly<Record<string, ToolAction>>
  readonly requires: ToolRequires
  readonly handler: ToolHandler
  readonly tests: readonly ToolCase[]
  readonly author?: string
  readonly lineage?: unknown
}

/** A cell answer as the cell host gives it (pinned `invoke`, or a kept cell's run). */
export interface ToolCellAnswer { readonly ok: boolean; readonly result?: unknown; readonly code?: unknown; readonly fuelUsed?: unknown }

/** The storage the registry needs: her VFS (MemoryVfs satisfies it). */
export interface ToolVfs {
  existsSync(path: string): boolean
  readdirSync(path: string): unknown[]
  readFileSync(path: string, encoding?: unknown): unknown
  writeFileSync(path: string, data: Uint8Array | string): void
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown
  unlinkSync(path: string): void
  statSync(path: string): { size: number | bigint; isDirectory(): boolean; isFile?(): boolean }
}

export interface ToolRegistryDeps {
  readonly vfs: ToolVfs
  /** A pinned cell's pin (its SHA-256 and ops), or null when the name is not pinned. */
  readonly pinned: (name: string) => { readonly sha256: string; readonly ops: readonly string[] } | null
  /** A kept forged cell by the SHA-256 of its admitted bytes: its manifest's address and kept WAT hash, or null. */
  readonly forged: (sha: string) => { readonly sha256: string; readonly watSha256: string; readonly name: string } | null
  /** One call of a pinned cell: the host admits its bytes against the pin and journals the call. */
  readonly runPinned: (name: string, op: string, input: Json) => Promise<ToolCellAnswer>
  /** One run of a kept forged cell: rebuilt from its kept WAT, re-admitted (zero imports, fuel bounded), journaled. */
  readonly runForged: (sha: string, op: string, input: Json) => Promise<ToolCellAnswer>
  /** True only when the owner's session is proven now (the loader asks the edge). */
  readonly ownerSession: () => Promise<boolean>
  /** True when a tool of this exact name is already registered by anything else. */
  readonly toolTaken: (toolName: string) => boolean
  readonly now?: () => number
}

export type ToolAnswer = Json

/** `x6t_<name with - as _>`: the tool a mounted manifest is exposed as. */
export const toolNameOf = (name: string): string => `${TOOL_PREFIX}${name.replace(/-/g, '_')}`
const proposalDirOf = (name: string): string => `${TOOL_PROPOSALS_DIR}/${name}`
export const proposalPathOf = (name: string, sha: string): string => `${proposalDirOf(name)}/${sha}.json`
export const mountedPathOf = (name: string): string => `${TOOL_MOUNTED_DIR}/${name}.json`

function canonical(value: unknown): string | null {
  try { return cellCanonicalJson(value) } catch { return null }
}

/** Bytes of one file as UTF-8 text, sized before it is read; null when missing, unreadable, over `max` or not text. */
function readText(vfs: ToolVfs, path: string, max: number): string | null {
  try {
    const stat = vfs.statSync(path)
    if (stat.isDirectory() || Number(stat.size) > max) return null
    const value = vfs.readFileSync(path)
    const bytes = typeof value === 'string' ? encoder.encode(value) : value instanceof Uint8Array ? value : null
    if (bytes === null || bytes.byteLength > max) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return null }
}

function listDir(vfs: ToolVfs, dir: string): string[] {
  try { return vfs.existsSync(dir) ? [...vfs.readdirSync(dir)].map(String).sort() : [] } catch { return [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// The manifest: shape, then tier.
// ---------------------------------------------------------------------------------------------------------------------

/** A `home-read` pattern: under /dsh/home/auma/, plain segments, `*` (one segment) and `**` (any depth); null when bad. */
function patternProblem(pattern: unknown): string | null {
  if (typeof pattern !== 'string' || pattern.length > 256 || !pattern.startsWith(TOOL_HOME_READ_ROOT)) return 'outside /dsh/home/auma/'
  if (/[\0\\?[\]{}]/.test(pattern)) return 'characters'
  const segments = pattern.slice(TOOL_HOME_READ_ROOT.length).split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return 'segments'
  if (segments.some(segment => segment.includes('**') && segment !== '**')) return 'segments'
  // Her private folder can never be declared: the first folder is named (a wildcard there could reach `private/`), and
  // it is not `private` (the same rule as her estate and voice, browser-estate.ts estateRedaction).
  const first = segments[0] ?? ''
  if (first.includes('*')) return 'name its first folder (a wildcard there could reach her private folder)'
  if (estateRedaction(TOOL_HOME_READ_ROOT + first) === 'private') return 'her private folder'
  // A secret file name, written out, is refused here; one a wildcard matches is refused at every read.
  const last = segments[segments.length - 1] ?? ''
  if (!last.includes('*') && estateRedaction(pattern) !== null) return 'a secret file name'
  return null
}

function patternRegExp(pattern: string): RegExp {
  const body = pattern.split('/').map(segment => segment === '**' ? '\u0000'
    : segment.split('*').map(part => part.replace(/[.+^$()|]/g, '\\$&')).join('[^/]*')).join('/')
  return new RegExp(`^${body.replace(/\/\u0000\//g, '/(?:[^/]+/)*').replace(/\/\u0000$/, '/.+')}$`, 'u')
}

/** A path she may read for a tool: absolute, folded, under /dsh/home/auma/, not private, not a secret, matching a pattern. */
export function homeReadRefusal(path: unknown, patterns: readonly string[]): string | null {
  const resolved = resolveVoicePath(path)
  if (resolved === null || resolved !== path) return 'TOOL_READ_PATH_INVALID'
  if (!resolved.startsWith(TOOL_HOME_READ_ROOT)) return 'TOOL_READ_OUTSIDE'
  if (estateRedaction(resolved) !== null) return 'TOOL_READ_PRIVATE'
  if (!patterns.some(pattern => patternRegExp(pattern).test(resolved))) return 'TOOL_READ_UNDECLARED'
  return null
}

/** The shape of a manifest, or the first problem (TOOL_MANIFEST_INVALID with a detail). Tier is judged separately. */
export function toolShapeProblem(value: unknown): string | null {
  if (!record(value)) return 'not an object'
  for (const key of Object.keys(value)) if (!MANIFEST_KEYS.has(key)) return `unknown key ${key.slice(0, 40)}`
  if (value.schema !== TOOL_SCHEMA) return `schema is not ${TOOL_SCHEMA}`
  if (typeof value.name !== 'string' || !TOOL_NAME.test(value.name)) return 'name: [a-z][a-z0-9-]{1,30}'
  if (typeof value.version !== 'string' || value.version.length < 1 || value.version.length > 32) return 'version: 1 to 32 characters'
  if (typeof value.description !== 'string' || value.description.length < 1 || value.description.length > 1024) return 'description: 1 to 1024 characters'
  if (value.author !== undefined && (typeof value.author !== 'string' || value.author.length > 64)) return 'author'
  if (!record(value.actions)) return 'actions: an object'
  const actions = Object.keys(value.actions)
  if (actions.length < 1 || actions.length > TOOL_MAX_ACTIONS) return `actions: 1 to ${String(TOOL_MAX_ACTIONS)}`
  for (const name of actions) {
    const action = value.actions[name]
    if (!ACTION_NAME.test(name) || !record(action)) return `action ${name.slice(0, 40)}`
    for (const key of Object.keys(action)) if (!ACTION_KEYS.has(key)) return `action ${name}: unknown key ${key.slice(0, 40)}`
    if (action.description !== undefined && (typeof action.description !== 'string' || action.description.length > 512)) return `action ${name}: description`
    if (typeof action.readOnly !== 'boolean') return `action ${name}: readOnly must be true or false`
    if (typeof action.authority !== 'string' || !/^[A-D]$/.test(action.authority)) return `action ${name}: authority A to D`
  }
  if (!record(value.requires)) return 'requires: an object'
  for (const key of Object.keys(value.requires)) if (!REQUIRES_KEYS.has(key)) return `requires: unknown key ${key.slice(0, 40)}`
  const { services, secrets, network, reads } = value.requires
  if (!Array.isArray(services) || services.length > 16 || services.some(item => typeof item !== 'string' || item.length > 64)) return 'requires.services'
  if (secrets !== undefined && (!Array.isArray(secrets) || secrets.length > 16 || secrets.some(item => typeof item !== 'string' || item.length > 128))) return 'requires.secrets'
  if (network !== undefined && typeof network !== 'boolean') return 'requires.network'
  if (reads !== undefined && (!Array.isArray(reads) || reads.length > TOOL_READ_PATTERNS_MAX || reads.some(item => typeof item !== 'string'))) return 'requires.reads'
  // A JavaScript handler (`ball:<sha256>`) has a shape; its tier is judged below.
  if (typeof value.handler === 'string') return /^ball:[a-f0-9]{64}$/.test(value.handler) ? null : 'handler'
  if (!record(value.handler)) return 'handler: { cell | pin, op, program? }'
  for (const key of Object.keys(value.handler)) if (!HANDLER_KEYS.has(key)) return `handler: unknown key ${key.slice(0, 40)}`
  const handler = value.handler
  if ((handler.cell === undefined) === (handler.pin === undefined)) return 'handler: exactly one of cell (sha256) or pin (name)'
  if (handler.cell !== undefined && (typeof handler.cell !== 'string' || !SHA.test(handler.cell))) return 'handler.cell: the sha256 of a kept forged cell'
  if (handler.pin !== undefined && (typeof handler.pin !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(handler.pin))) return 'handler.pin: a pinned cell name'
  if (typeof handler.op !== 'string' || !OP.test(handler.op)) return 'handler.op'
  if (handler.program !== undefined && !record(handler.program)) return 'handler.program: an object'
  if (record(handler.program) && Object.keys(handler.program).some(key => HOST_INPUT_KEYS.has(key))) return 'handler.program may not name files or action'
  if (!Array.isArray(value.tests) || value.tests.length < 1 || value.tests.length > TOOL_MAX_CASES) return `tests: 1 to ${String(TOOL_MAX_CASES)} cases`
  const names = new Set<string>()
  for (const [index, entry] of (value.tests as unknown[]).entries()) {
    if (!record(entry)) return `tests[${String(index)}]`
    for (const key of Object.keys(entry)) if (!CASE_KEYS.has(key)) return `tests[${String(index)}]: unknown key ${key.slice(0, 40)}`
    if (typeof entry.name !== 'string' || !CASE_NAME.test(entry.name) || names.has(entry.name)) return `tests[${String(index)}].name (unique)`
    names.add(entry.name)
    if (entry.action !== undefined && (typeof entry.action !== 'string' || !actions.includes(entry.action))) return `tests[${String(index)}].action`
    if (entry.input !== undefined && !record(entry.input)) return `tests[${String(index)}].input: an object`
    if (entry.files !== undefined && (!Array.isArray(entry.files) || entry.files.length > TOOL_HOME_READ_MAX_FILES
      || entry.files.some(file => !record(file) || typeof file.path !== 'string' || typeof file.text !== 'string'))) return `tests[${String(index)}].files`
    const expect = entry.expect
    if (!record(expect) || typeof expect.ok !== 'boolean') return `tests[${String(index)}].expect: { ok, result | not | code }`
    if (expect.ok && (Object.hasOwn(expect, 'result') === Object.hasOwn(expect, 'not'))) return `tests[${String(index)}].expect: exactly one of result or not`
    if (!expect.ok && (Object.hasOwn(expect, 'result') || Object.hasOwn(expect, 'not')
      || (expect.code !== undefined && (typeof expect.code !== 'string' || expect.code.length > 80)))) return `tests[${String(index)}].expect`
  }
  return null
}

/** One reason the manifest is outside tier T1, with the tier it would need. */
export interface TierRefusal { readonly code: 'TOOL_TIER_NOT_OPEN'; readonly needs: 'T2' | 'T3' | 'JS_SANDBOX'; readonly detail: string }

/** D1 and D2: every reason this manifest is not T1 (empty when it is). Judged after the shape. */
export function toolTierRefusals(manifest: ToolManifest | Json): TierRefusal[] {
  const out: TierRefusal[] = []
  const refuse = (needs: TierRefusal['needs'], detail: string): void => { out.push({ code: 'TOOL_TIER_NOT_OPEN', needs, detail }) }
  const value = manifest as Json
  if (typeof value.handler === 'string') refuse('JS_SANDBOX', 'a JavaScript handler needs a real sandbox (a later job); use a forged or pinned cell')
  for (const [name, action] of Object.entries(record(value.actions) ? value.actions : {})) {
    if (!record(action)) continue
    if (action.readOnly !== true) refuse('T2', `action ${name} writes (readOnly is not true)`)
    if (action.authority !== 'A') refuse(action.authority === 'B' ? 'T2' : 'T3', `action ${name} asks for authority ${String(action.authority)}`)
  }
  const requires = record(value.requires) ? value.requires : {}
  const services = Array.isArray(requires.services) ? requires.services as string[] : []
  for (const service of services) {
    if (!TOOL_SERVICES_T1.includes(service)) refuse(['fs', 'write', 'home-write'].includes(service) ? 'T2' : 'T3', `service ${service.slice(0, 64)}`)
  }
  if (Array.isArray(requires.secrets) && requires.secrets.length > 0) refuse('T3', 'secrets')
  if (requires.network === true) refuse('T3', 'network')
  const reads = Array.isArray(requires.reads) ? requires.reads as string[] : []
  if (services.includes('home-read') && reads.length === 0) refuse('T2', 'home-read without explicit path patterns')
  if (!services.includes('home-read') && reads.length > 0) refuse('T2', 'reads declared without the home-read service')
  for (const pattern of reads) {
    const problem = patternProblem(pattern)
    if (problem !== null) refuse('T3', `read pattern ${pattern.slice(0, 80)}: ${problem}`)
  }
  return out
}

/** True when every action of this manifest is a read at authority A and nothing in it is outside T1: what the capability
 * index and `list` say about a mounted tool, derived from its manifest and never from where it was registered. */
export function manifestReadOnly(manifest: ToolManifest | Json): boolean {
  const actions = record((manifest as Json).actions) ? Object.values((manifest as Json).actions as Json) : []
  return actions.length > 0 && actions.every(action => record(action) && action.readOnly === true && action.authority === 'A')
    && toolTierRefusals(manifest).length === 0
}

/** A suite with no case that is refused or must differ cannot fail: TOOL_TESTS_CANNOT_FAIL. */
export function suiteCanFail(tests: readonly ToolCase[]): boolean {
  return tests.some(entry => !entry.expect.ok || Object.hasOwn(entry.expect, 'not'))
}

/** The machine-made capability diff (her section 4): what mounting this adds; nothing is ever removed by a mount. */
export function capabilityDiff(manifest: ToolManifest): { lines: string[]; added: Json; removed: string[] } {
  const actions = Object.entries(manifest.actions).map(([name, action]) => `${name} (${action.authority}${action.readOnly ? ', read-only' : ''})`)
  const services = manifest.requires.services
  const reads = manifest.requires.reads ?? []
  const handler = 'pin' in manifest.handler ? `pinned cell ${manifest.handler.pin} op ${manifest.handler.op}`
    : `forged cell ${manifest.handler.cell} op ${manifest.handler.op}`
  const lines = [
    `+ tool: ${manifest.name} (${toolNameOf(manifest.name)}) version ${manifest.version}`,
    `+ actions: ${actions.join(', ')}`,
    `+ services: ${services.length === 0 ? 'none' : services.join(', ')}`,
    ...(reads.length > 0 ? [`+ reads: ${reads.join(', ')}`] : []),
    '+ secrets: none',
    '+ network: false',
    `+ handler: ${handler} (zero imports, fuel bounded)`,
    '+ new authority: none (every action is a read)',
    '- no existing action is removed',
  ]
  const added = { tool: toolNameOf(manifest.name), actions: Object.keys(manifest.actions), services: [...services], reads: [...reads],
    secrets: [], network: false, authority: 'A' }
  return { lines, added, removed: [] }
}

// ---------------------------------------------------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------------------------------------------------

interface HeldProposal {
  readonly name: string
  readonly sha256: string
  readonly path: string
  readonly manifest: ToolManifest
  readonly bytes: string
}
interface MountedRecord {
  readonly schema: typeof TOOL_MOUNT_SCHEMA
  readonly name: string
  readonly tool: string
  readonly proposalId: string
  readonly sha256: string
  readonly qualificationId: string
  readonly handler: { readonly kind: 'pinned' | 'forged'; readonly ref: string; readonly sha256: string }
  readonly diff: { lines: string[]; added: Json; removed: string[] }
  readonly mountedAt: number
}

const proposalIdOf = (name: string, sha: string): string => `${name}@${sha}`
function parseProposalId(value: unknown): { name: string; sha: string } | null {
  if (typeof value !== 'string' || value.length > 100) return null
  const at = value.indexOf('@')
  const name = value.slice(0, at), sha = value.slice(at + 1)
  return at > 0 && TOOL_NAME.test(name) && SHA.test(sha) ? { name, sha } : null
}

/**
 * The registry over one session: her VFS, her cell host, the owner probe. `execute` answers the five verbs of `x6_tools`;
 * `call` runs one mounted tool; `mounted` lists what to register.
 */
export function createToolRegistry(deps: ToolRegistryDeps) {
  const { vfs } = deps
  const now = deps.now ?? (() => Date.now())

  const readProposal = (name: string, sha: string): HeldProposal | { refusal: Json } => {
    const path = proposalPathOf(name, sha)
    const bytes = readText(vfs, path, TOOL_PROPOSAL_MAX_BYTES)
    if (bytes === null) return { refusal: { ok: false, code: 'TOOL_PROPOSAL_UNKNOWN', proposalId: proposalIdOf(name, sha) } }
    if (sha256(bytes) !== sha) return { refusal: { ok: false, code: 'QUALIFICATION_STALE', detail: 'the proposal file no longer hashes to its id' } }
    let value: unknown
    try { value = JSON.parse(bytes) } catch { return { refusal: { ok: false, code: 'TOOL_PROPOSAL_UNKNOWN' } } }
    const manifest = record(value) ? value.manifest : undefined
    if (toolShapeProblem(manifest) !== null || !record(manifest) || manifest.name !== name) {
      return { refusal: { ok: false, code: 'TOOL_MANIFEST_INVALID' } }
    }
    return { name, sha256: sha, path, manifest: manifest as unknown as ToolManifest, bytes }
  }

  const listProposals = (): Array<{ name: string; sha256: string; path: string }> => {
    const out: Array<{ name: string; sha256: string; path: string }> = []
    for (const name of listDir(vfs, TOOL_PROPOSALS_DIR)) {
      if (!TOOL_NAME.test(name)) continue
      for (const file of listDir(vfs, proposalDirOf(name))) {
        const sha = PROPOSAL_FILE.exec(file)?.[1]
        if (sha) out.push({ name, sha256: sha, path: proposalPathOf(name, sha) })
      }
    }
    return out
  }

  const readMounted = (name: string): MountedRecord | null => {
    const text = readText(vfs, mountedPathOf(name), 64 * 1024)
    if (text === null) return null
    try {
      const value: unknown = JSON.parse(text)
      if (!record(value) || value.schema !== TOOL_MOUNT_SCHEMA || value.name !== name || canonical(value) !== text) return null
      return value as unknown as MountedRecord
    } catch { return null }
  }
  const mountedNames = (): string[] => listDir(vfs, TOOL_MOUNTED_DIR).map(file => MOUNTED_FILE.exec(file)?.[1])
    .filter((name): name is string => !!name)

  /** The handler's identity now: kind, reference and the SHA-256 of the bytes that will run; or why it cannot run. */
  const handlerNow = (handler: ToolHandler): { kind: 'pinned' | 'forged'; ref: string; sha256: string; ops: readonly string[] | null } | Json => {
    if ('pin' in handler) {
      const pin = deps.pinned(handler.pin)
      if (pin === null) return { ok: false, code: 'TOOL_HANDLER_UNKNOWN', detail: `no pinned cell ${handler.pin}` }
      if (!pin.ops.includes(handler.op)) return { ok: false, code: 'TOOL_HANDLER_OP', ops: [...pin.ops] }
      return { kind: 'pinned', ref: handler.pin, sha256: pin.sha256, ops: pin.ops }
    }
    const kept = deps.forged(handler.cell)
    if (kept === null || kept.sha256 !== handler.cell) return { ok: false, code: 'TOOL_HANDLER_UNKNOWN', detail: 'no kept forged cell with that sha256' }
    return { kind: 'forged', ref: handler.cell, sha256: sha256(`${kept.sha256}\n${kept.watSha256}`), ops: null }
  }

  /** The input one cell call gets: program, then the caller's input, then the host's own keys; null on a collision. */
  const cellInput = (manifest: ToolManifest, action: string, input: Json, files: Json[] | null): Json | null => {
    const program = manifest.handler.program ?? {}
    for (const key of Object.keys(input)) if (Object.hasOwn(program, key) || HOST_INPUT_KEYS.has(key)) return null
    return { ...program, ...input, ...(Object.keys(manifest.actions).length > 1 ? { action } : {}), ...(files !== null ? { files } : {}) }
  }

  const runCell = async (manifest: ToolManifest, input: Json): Promise<ToolCellAnswer> => {
    const handler = manifest.handler
    try {
      return 'pin' in handler ? await deps.runPinned(handler.pin, handler.op, input) : await deps.runForged(handler.cell, handler.op, input)
    } catch { return { ok: false, code: 'TOOL_CELL_FAILED' } }
  }

  const sameJson = (left: unknown, right: unknown): boolean => {
    const a = canonical(left), b = canonical(right)
    return a !== null && a === b
  }

  const suiteShaOf = (manifest: ToolManifest): string => sha256(cellCanonicalJson({ host: TOOL_HOST_SUITE, tests: manifest.tests }))
  /** The id a qualification of these exact bytes answers: manifest, the handler bytes' SHA-256 and the suite. */
  const qualificationIdOf = (manifest: ToolManifest, handlerSha: string, suiteSha256: string): string =>
    sha256(cellCanonicalJson({ manifest, handler: handlerSha, suite: suiteSha256 }))

  /** Every case through the sealed cell, the tier, and the id bound to the exact bytes. */
  const qualifyHeld = async (held: HeldProposal): Promise<Json> => {
    const manifest = held.manifest
    const refusals: Json[] = toolTierRefusals(manifest).map(refusal => ({ ...refusal }))
    if (!suiteCanFail(manifest.tests)) refusals.push({ code: 'TOOL_TESTS_CANNOT_FAIL', detail: 'add a case that must be refused or must differ' })
    const handler = typeof manifest.handler === 'string' ? null : handlerNow(manifest.handler)
    if (handler !== null && 'ok' in handler) refusals.push({ code: handler.code, detail: handler.detail ?? null })
    const suiteSha256 = suiteShaOf(manifest)
    const cases: Json[] = []
    if (refusals.length === 0 && handler !== null && !('ok' in handler)) {
      const patterns = manifest.requires.reads ?? []
      for (const entry of manifest.tests) {
        const started = now()
        const action = entry.action ?? Object.keys(manifest.actions)[0] ?? ''
        let files: Json[] | null = null
        if (entry.files !== undefined) {
          const refused = entry.files.map(file => homeReadRefusal(file.path, patterns)).find(code => code !== null)
          if (refused) {
            cases.push({ id: entry.name, ok: false, ms: 0, detail: `${refused}: a fixture path the manifest may not read` })
            continue
          }
          files = entry.files.map(file => ({ path: file.path, text: file.text, size: encoder.encode(file.text).byteLength,
            sha256: sha256(file.text) }))
        }
        const input = cellInput(manifest, action, entry.input ?? {}, files)
        if (input === null) {
          cases.push({ id: entry.name, ok: false, ms: 0, detail: 'TOOL_INPUT_COLLIDES: the input names a program or host key' })
          continue
        }
        const answer = await runCell(manifest, input)
        const expect = entry.expect
        const ok = !expect.ok ? !answer.ok && (expect.code === undefined || answer.code === expect.code)
          : answer.ok && ('result' in expect ? sameJson(answer.result, expect.result) : !sameJson(answer.result, expect.not))
        const refusedCode = typeof answer.code === 'string' ? answer.code.slice(0, 80) : '?'
        cases.push({ id: entry.name, ok, ms: Math.max(0, now() - started),
          detail: answer.ok ? `result ${(canonical(answer.result) ?? '?').slice(0, 120)}` : `refused ${refusedCode}` })
      }
    }
    const qualified = refusals.length === 0 && cases.length === manifest.tests.length && cases.every(entry => entry.ok === true)
    const handlerSha = handler !== null && !('ok' in handler) && typeof handler.sha256 === 'string' ? handler.sha256 : null
    const qualificationId = qualified && handlerSha !== null ? qualificationIdOf(manifest, handlerSha, suiteSha256) : null
    return { ok: true, qualified, qualificationId, proposalId: proposalIdOf(held.name, held.sha256), suiteSha256, cases, refusals }
  }

  const propose = (args: Json): Json => {
    const manifest = args.manifest
    const notes = args.notes === undefined ? null : args.notes
    if (notes !== null && (typeof notes !== 'string' || notes.length > TOOL_NOTES_MAX_CHARS)) return { ok: false, code: 'TOOL_NOTES_INVALID', max: TOOL_NOTES_MAX_CHARS }
    const manifestText = canonical(manifest)
    if (manifestText === null) return { ok: false, code: 'TOOL_MANIFEST_INVALID', detail: 'not canonical JSON (integers only, no floats)' }
    if (encoder.encode(manifestText).byteLength > TOOL_MANIFEST_MAX_BYTES) return { ok: false, code: 'TOOL_MANIFEST_LIMIT', max: TOOL_MANIFEST_MAX_BYTES }
    const problem = toolShapeProblem(manifest)
    if (problem !== null) return { ok: false, code: 'TOOL_MANIFEST_INVALID', detail: problem }
    const tier = toolTierRefusals(manifest as Json)
    if (tier.length > 0) return { ok: false, code: 'TOOL_TIER_NOT_OPEN', needs: tier[0]?.needs, refusals: tier }
    const name = (manifest as ToolManifest).name
    const bytes = cellCanonicalJson({ manifest, notes })
    if (encoder.encode(bytes).byteLength > TOOL_PROPOSAL_MAX_BYTES) return { ok: false, code: 'TOOL_MANIFEST_LIMIT', max: TOOL_PROPOSAL_MAX_BYTES }
    const sha = sha256(bytes)
    const path = proposalPathOf(name, sha)
    const mountedIds = new Set(mountedNames().map(mountedName => readMounted(mountedName)?.proposalId))
    const open = listProposals().filter(entry => !mountedIds.has(proposalIdOf(entry.name, entry.sha256))).length
    if (!vfs.existsSync(path) && open >= TOOL_PROPOSALS_MAX) {
      return { ok: false, code: 'TOOL_PROPOSALS_FULL', max: TOOL_PROPOSALS_MAX, next: 'withdraw one first: { action: "unmount", proposalId }' }
    }
    try {
      vfs.mkdirSync(proposalDirOf(name), { recursive: true })
      const proposalPath = proposalPathOf(name, sha)
      vfs.writeFileSync(proposalPath, bytes)
    } catch { return { ok: false, code: 'TOOL_STORE_FAILED' } }
    return { ok: true, proposalId: proposalIdOf(name, sha), path, sha256: sha, mounted: false,
      next: `{ action: "qualify", proposalId: "${proposalIdOf(name, sha)}" }` }
  }

  const resolveProposal = (args: Json): HeldProposal | { refusal: Json } => {
    const id = parseProposalId(args.proposalId)
    if (id === null) return { refusal: { ok: false, code: 'TOOL_PROPOSAL_UNKNOWN', next: 'proposalId is <name>@<sha256> as propose answered it' } }
    return readProposal(id.name, id.sha)
  }

  const qualify = async (args: Json): Promise<Json> => {
    const held = resolveProposal(args)
    return 'refusal' in held ? held.refusal : await qualifyHeld(held)
  }

  const mount = async (args: Json): Promise<Json> => {
    const held = resolveProposal(args)
    if ('refusal' in held) return held.refusal
    if (typeof args.qualificationId !== 'string' || !SHA.test(args.qualificationId)) return { ok: false, code: 'QUALIFICATION_STALE', detail: 'no qualificationId' }
    // Qualified again now, against the bytes as they are: any change to the manifest, the handler or the suite moves the id.
    const fresh = await qualifyHeld(held)
    if (fresh.qualified !== true || fresh.qualificationId !== args.qualificationId) {
      return { ok: false, code: 'QUALIFICATION_STALE', qualified: fresh.qualified, refusals: fresh.refusals,
        next: 'qualify the proposal again and mount with the new qualificationId' }
    }
    const name = held.manifest.name
    const tool = toolNameOf(name)
    const existing = readMounted(name)
    if (existing !== null && existing.qualificationId === args.qualificationId) return { ok: true, mounted: 'already', name, tool }
    if (existing !== null || vfs.existsSync(mountedPathOf(name)) || deps.toolTaken(tool)) {
      return { ok: false, code: 'TOOL_NAME_TAKEN', name, tool, next: 'unmount it first, or choose another name' }
    }
    if (mountedNames().length >= TOOLS_MOUNTED_MAX) return { ok: false, code: 'TOOLS_FULL', max: TOOLS_MOUNTED_MAX, next: 'unmount one first' }
    // D3: the owner's session, asked last (after every cheap refusal), and answered by the edge.
    let owner = false
    try { owner = await deps.ownerSession() } catch { owner = false }
    if (!owner) return { ok: false, code: 'OWNER_REQUIRED', next: 'the owner mounts it from his signed-in session' }
    const handler = handlerNow(held.manifest.handler) as { kind: 'pinned' | 'forged'; ref: string; sha256: string }
    const diff = capabilityDiff(held.manifest)
    const when = now()
    const mounted: MountedRecord = { schema: TOOL_MOUNT_SCHEMA, name, tool, proposalId: proposalIdOf(name, held.sha256),
      sha256: held.sha256, qualificationId: args.qualificationId, handler: { kind: handler.kind, ref: handler.ref, sha256: handler.sha256 },
      diff, mountedAt: when }
    // Synchronous from the last check to the write: no other call can take the name in between.
    if (vfs.existsSync(mountedPathOf(name)) || mountedNames().length >= TOOLS_MOUNTED_MAX) return { ok: false, code: 'TOOL_NAME_TAKEN', name, tool }
    try {
      vfs.mkdirSync(TOOL_MOUNTED_DIR, { recursive: true })
      const mountedPath = mountedPathOf(name)
      vfs.writeFileSync(mountedPath, cellCanonicalJson(mounted))
    } catch { return { ok: false, code: 'TOOL_STORE_FAILED' } }
    return { ok: true, mounted: true, name, tool, diff, when }
  }

  const unmount = (args: Json): Json => {
    // `{ proposalId }` withdraws an open proposal (never one a mounted tool stands on): proposals are bounded, so she
    // must be able to let one go.
    if (args.proposalId !== undefined) {
      const id = parseProposalId(args.proposalId)
      if (id === null || !vfs.existsSync(proposalPathOf(id.name, id.sha))) return { ok: false, code: 'TOOL_PROPOSAL_UNKNOWN' }
      if (readMounted(id.name)?.sha256 === id.sha) return { ok: false, code: 'TOOL_PROPOSAL_MOUNTED', next: 'unmount the tool first: { action: "unmount", name }' }
      try {
        const withdrawPath = proposalPathOf(id.name, id.sha)
        vfs.unlinkSync(withdrawPath)
      } catch { return { ok: false, code: 'TOOL_STORE_FAILED' } }
      return { ok: true, withdrawn: proposalIdOf(id.name, id.sha) }
    }
    const name = typeof args.name === 'string' ? args.name.replace(/^x6t_/, '').replace(/_/g, '-') : ''
    if (!TOOL_NAME.test(name) || !vfs.existsSync(mountedPathOf(name))) return { ok: false, code: 'TOOL_NOT_MOUNTED', name: name.slice(0, 40) }
    try {
      const unmountPath = mountedPathOf(name)
      vfs.unlinkSync(unmountPath)
    } catch { return { ok: false, code: 'TOOL_STORE_FAILED' } }
    return { ok: true, unmounted: true, name, tool: toolNameOf(name) }
  }

  /**
   * A mounted record as it stands now, judged again from its bytes (review fix): the record names itself, its proposal reads
   * back whole, the manifest is still T1 with a cell handler and a suite that can fail, the handler bytes are the ones it
   * was mounted with, and its qualification id is the one these exact bytes give. Anything written into
   * /dsh/home/tools/ by another path (her generic `write` reaches it) fails here and is never registered or run.
   */
  const vetMounted = (name: string): { row: MountedRecord; held: HeldProposal } | { code: string; detail?: string; tool?: string } => {
    const row = readMounted(name)
    if (row === null) return { code: 'TOOL_NOT_MOUNTED' }
    const tool = toolNameOf(name)
    if (row.tool !== tool || typeof row.sha256 !== 'string' || !SHA.test(row.sha256) || row.proposalId !== proposalIdOf(name, row.sha256)
      || typeof row.qualificationId !== 'string' || !SHA.test(row.qualificationId) || !record(row.handler)) {
      return { code: 'TOOL_RECORD_CHANGED', tool, detail: 'the mounted record does not name itself' }
    }
    const held = readProposal(name, row.sha256)
    if ('refusal' in held) return { code: 'TOOL_RECORD_CHANGED', tool, detail: 'its proposal no longer reads back whole' }
    const manifest = held.manifest
    if (!record(manifest.handler) || toolTierRefusals(manifest).length > 0 || !suiteCanFail(manifest.tests)) {
      return { code: 'TOOL_RECORD_CHANGED', tool, detail: 'its manifest is outside tier T1' }
    }
    const handler = handlerNow(manifest.handler)
    if ('ok' in handler || handler.sha256 !== row.handler.sha256 || handler.kind !== row.handler.kind) {
      return { code: 'TOOL_HANDLER_CHANGED', tool, detail: 'its cell changed since it was qualified: propose, qualify and mount it again' }
    }
    if (qualificationIdOf(manifest, handler.sha256, suiteShaOf(manifest)) !== row.qualificationId) {
      return { code: 'TOOL_RECORD_CHANGED', tool, detail: 'its qualification id is not the one these bytes give' }
    }
    return { row, held }
  }
  /** Qualification ids whose suite this session has run and passed: a record never qualified fails its first call. */
  const provenThisSession = new Set<string>()

  const list = (): Json => {
    const mounted: Json[] = []
    const unreadable: string[] = []
    const mountedIds = new Set<string>()
    for (const name of mountedNames()) {
      const row = readMounted(name)
      const held = row === null ? null : readProposal(name, row.sha256)
      if (row === null || held === null || 'refusal' in held) { unreadable.push(name); continue }
      mountedIds.add(row.proposalId)
      const vetted = vetMounted(name)
      const readOnly = manifestReadOnly(held.manifest)
      mounted.push({ name, tool: row.tool, version: held.manifest.version, readOnly, mutating: !readOnly, authority: readOnly ? 'A' : 'unknown',
        actions: Object.keys(held.manifest.actions), requires: held.manifest.requires, sha256: row.sha256,
        qualificationId: row.qualificationId, handler: row.handler, mountedAt: row.mountedAt,
        ...('code' in vetted ? { runnable: false, code: vetted.code } : { runnable: true }) })
    }
    const proposals = listProposals().filter(entry => !mountedIds.has(proposalIdOf(entry.name, entry.sha256)))
      .map(entry => ({ proposalId: proposalIdOf(entry.name, entry.sha256), name: entry.name, sha256: entry.sha256, path: entry.path }))
    return { ok: true, tier: 'T1', count: mounted.length, max: TOOLS_MOUNTED_MAX, mounted, proposals,
      ...(unreadable.length > 0 ? { unreadable } : {}) }
  }

  /** What to register: every mounted tool whose record passes vetMounted now (a T1 manifest bound to its bytes). */
  const mountedTools = (): Array<{ name: string; tool: string; manifest: ToolManifest }> => {
    const out: Array<{ name: string; tool: string; manifest: ToolManifest }> = []
    for (const name of mountedNames()) {
      const vetted = vetMounted(name)
      if (!('code' in vetted)) out.push({ name, tool: vetted.row.tool, manifest: vetted.held.manifest })
    }
    return out
  }

  /** One call of a mounted tool: its record vetted again, its suite proven once per session, the files read and bounded,
   * one cell call. */
  const call = async (name: string, args: Json): Promise<Json> => {
    const vetted = vetMounted(name)
    if ('code' in vetted) return { ok: false, code: vetted.code, tool: vetted.tool ?? toolNameOf(name), ...(vetted.detail ? { next: vetted.detail } : {}) }
    const { row, held } = vetted
    const manifest = held.manifest
    if (!provenThisSession.has(row.qualificationId)) {
      const fresh = await qualifyHeld(held)
      if (fresh.qualified !== true || fresh.qualificationId !== row.qualificationId) {
        return { ok: false, code: 'TOOL_RECORD_CHANGED', tool: row.tool, next: 'its own suite does not pass on these bytes: qualify and mount it again' }
      }
      provenThisSession.add(row.qualificationId)
    }
    const actions = Object.keys(manifest.actions)
    const action = args.act === undefined && actions.length === 1 ? actions[0] as string : typeof args.act === 'string' ? args.act : ''
    if (!actions.includes(action)) return { ok: false, code: 'TOOL_ACTION_UNKNOWN', actions }
    if (args.input !== undefined && !record(args.input)) return { ok: false, code: 'TOOL_INPUT_INVALID', next: 'input is an object' }
    let files: Json[] | null = null
    if (args.paths !== undefined) {
      if (!manifest.requires.services.includes('home-read')) return { ok: false, code: 'TOOL_READ_UNDECLARED', next: 'this tool reads no files' }
      if (!Array.isArray(args.paths) || args.paths.length > TOOL_HOME_READ_MAX_FILES) return { ok: false, code: 'TOOL_READ_LIMIT', max: TOOL_HOME_READ_MAX_FILES }
      files = []
      let total = 0
      for (const path of args.paths as unknown[]) {
        const refused = homeReadRefusal(path, manifest.requires.reads ?? [])
        if (refused !== null) return { ok: false, code: refused, path: typeof path === 'string' ? path.slice(0, 200) : null }
        const text = readText(vfs, path as string, TOOL_HOME_READ_MAX_BYTES - total)
        if (text === null) return { ok: false, code: 'TOOL_READ_FAILED', path, next: `missing, not UTF-8 text, or over ${String(TOOL_HOME_READ_MAX_BYTES)} bytes in all` }
        const size = encoder.encode(text).byteLength
        total += size
        files.push({ path, text, size, sha256: sha256(text) })
      }
    }
    const input = cellInput(manifest, action, record(args.input) ? args.input : {}, files)
    if (input === null) return { ok: false, code: 'TOOL_INPUT_COLLIDES', next: 'the input may not name a program key, files or action' }
    const answer = await runCell(manifest, input)
    return { ok: answer.ok, tool: row.tool, action, ...(answer.ok ? { result: answer.result } : { code: answer.code ?? 'TOOL_CELL_REFUSED' }),
      fuelUsed: typeof answer.fuelUsed === 'number' ? answer.fuelUsed : null, readOnly: true }
  }

  return {
    async execute(args: Json): Promise<Json> {
      if (args.action === 'propose') return propose(args)
      if (args.action === 'qualify') return await qualify(args)
      if (args.action === 'mount') return await mount(args)
      if (args.action === 'list') return list()
      if (args.action === 'unmount') return unmount(args)
      return { ok: false, code: 'TOOL_ACTION_INVALID', actions: [...TOOL_ACTIONS] }
    },
    call,
    mountedTools,
  }
}

export const TOOLS_TOOL_DESCRIPTION = 'Your own tools, tier T1 (docs/auma/tools.md). You write a tool as an `aukora.tool.v1` manifest: '
  + 'name ([a-z][a-z0-9-]{1,30}), version, description, `actions` (each `{ readOnly: true, authority: "A" }`), `requires` '
  + '(`services: []` or `["home-read"]` with `reads: ["/dsh/home/auma/<pattern>"]`; no secrets; no network), a `handler` that is a '
  + 'sealed cell you already have (`{ cell: <sha256 of a cell you forged>, op, program? }` or `{ pin: <pinned cell name>, op, program? }`), '
  + 'and `tests` (1 to 32 `{ name, action?, input, files?, expect }`; `expect` is `{ ok: true, result }`, `{ ok: true, not }` or '
  + '`{ ok: false, code? }`; at least one case must be refused or must differ). `propose { manifest, notes? }` keeps it under '
  + '/dsh/home/tools/proposals/ and mounts nothing. `qualify { proposalId }` runs every case through the cell and checks the tier; '
  + 'its qualificationId is bound to the exact bytes. `mount { proposalId, qualificationId }` needs the owner\'s signed-in session '
  + '(no fingerprint: it is reversible and adds no new act), answers the capability diff, and registers the tool as `x6t_<name>` '
  + '(its `availableAfter` says `now` or `reload`). `list {}` names every mounted tool and open proposal. `unmount { name }` removes a mounted tool; `unmount { proposalId }` '
  + 'withdraws an open proposal (64 open at most). A tool that writes, reads a secret, '
  + 'reaches the network or runs JavaScript is refused TOOL_TIER_NOT_OPEN with the tier it would need.'

export const TOOLS_TOOL_PARAMETERS = {
  action: { type: 'string', required: true, enum: [...TOOL_ACTIONS], description: '`propose`, `qualify`, `mount`, `list` or `unmount`.' },
  manifest: { type: 'json', description: 'For propose: the aukora.tool.v1 manifest (at most 64 KiB, 16 actions, 32 cases).' },
  notes: { type: 'string', description: 'For propose, optional: why (up to 4096 characters).' },
  proposalId: { type: 'string', description: 'For qualify and mount: <name>@<sha256> as propose answered it; for unmount, an open proposal to withdraw.' },
  qualificationId: { type: 'string', description: 'For mount: the id qualify answered.' },
  name: { type: 'string', description: 'For unmount: the tool\'s name (or its x6t_ name).' },
} as const

/** The parameters of one mounted tool `x6t_<name>`: her actions, her input, and for home-read the paths. */
export function mountedToolParameters(manifest: ToolManifest): Record<string, Record<string, unknown>> {
  const actions = Object.keys(manifest.actions)
  return {
    // The real `defineTool` (packages/core/tools/src/schema.ts:293-294) refuses `required: false`
    // ("required must be true when present"), so a one-action tool never registered, at mount or at boot. An optional
    // parameter carries no `required` key at all.
    act: { type: 'string', ...(actions.length > 1 ? { required: true } : {}), enum: actions,
      description: actions.map((name) => {
        const said = manifest.actions[name]?.description
        return `\`${name}\`${said ? `: ${said}` : ''}`
      }).join('; ') },
    input: { type: 'json', description: 'The input object for the action (integers only, no floats).' },
    ...(manifest.requires.services.includes('home-read')
      ? { paths: { type: 'json', description: `Up to ${String(TOOL_HOME_READ_MAX_FILES)} absolute paths to read, matching ${(manifest.requires.reads ?? []).join(', ')} (256 KiB in all).` } }
      : {}),
  }
}

export function mountedToolDescription(manifest: ToolManifest): string {
  return `${manifest.description} (Your tool ${manifest.name} ${manifest.version}, mounted through x6_tools: read-only, runs in a sealed cell.)`
}
