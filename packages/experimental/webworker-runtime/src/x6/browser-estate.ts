/**
 * Lane E4: `x6_browser_estate`, a read-only view of the browser half of Auma's estate that needs neither GitHub nor
 * a local host machine: the MemoryVfs tree under /dsh/home/auma (sizes and SHA-256 digests, every sub-workspace), a cross-thread
 * session index and bounded transcript search over /dsh/home/sessions/** (including the legacy `--dsh-home-auma-one--`
 * and `--dsh-home-auma--` directories), the IndexedDB persistence queue/tombstones/conflicts, the live Cordis fibers,
 * organs, tools and services, the Wasm cell pins and memory ceilings, and a summary of the receipt/checkpoint chain.
 *
 * Read-only: nothing here writes the VFS, IndexedDB, the network or a receipt. Anything under /dsh/home/auma/private/**
 * (or named like a key or credential) is listed by existence and size only: never content, never a digest of content.
 * Every section is bounded and the whole answer is capped; the VFS tree pages with `cursor`/`limit`.
 * @module x6/browser-estate
 */
import type { MemoryVfs } from '../storage/memory.ts'
import { sha256HexSync } from '../module-system/module-loader.ts'
import { CELL_BROWSER_FUEL_CAP, CELL_EXECUTION_TIMEOUT_MS, CELL_MAX_MEMORY_PAGES, CELL_PINS, SKILL_MAX_FUEL, SKILL_MAX_MEMORY_PAGES, WASM_PAGE_BYTES } from './wasm-cells.ts'

export const ESTATE_SECTIONS = Object.freeze(['vfs', 'sessions', 'search', 'persistence', 'cordis', 'wasm', 'receipts'] as const)
export type EstateSection = typeof ESTATE_SECTIONS[number]

export const ESTATE_LIMITS = Object.freeze({
  outputBytes: 256 * 1024,
  walkNodes: 20_000,
  defaultPage: 200,
  maxPage: 1000,
  perFileHashBytes: 1024 * 1024,
  maxPerFileHashBytes: 8 * 1024 * 1024,
  totalHashBytes: 16 * 1024 * 1024,
  sessionsListed: 200,
  sessionHeaderBytes: 4096,
  searchFiles: 200,
  searchBytes: 32 * 1024 * 1024,
  searchHits: 20,
  maxSearchHits: 100,
  queryChars: 128,
})

export const AUMA_ROOT = '/dsh/home/auma'
export const PRIVATE_ROOT = '/dsh/home/auma/private'
export const SESSIONS_ROOT = '/dsh/home/sessions'
const RECEIPTS_PATH = '/dsh/home/auma/seed/receipts.v3.jsonl'
const CHECKPOINTS_PATH = '/dsh/home/auma/seed/checkpoints.v1.jsonl'
const SENSITIVE_NAME = /(?:keypair|private[-_.]?key|secret|credential|password|\.pem$|\.key$|\.p12$|session\.cap$)/i

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Why a path's content is withheld, or null when it may be digested. */
export function estateRedaction(path: string): 'private' | 'sensitive-name' | null {
  if (path === PRIVATE_ROOT || path.startsWith(PRIVATE_ROOT + '/')) return 'private'
  const name = path.slice(path.lastIndexOf('/') + 1)
  return SENSITIVE_NAME.test(name) ? 'sensitive-name' : null
}

/** Decode a session directory name to the workspace it belongs to; legacy forms are named. */
export function decodeSessionWorkspace(dirName: string): { workspace: string | null; form: 'auma-root' | 'legacy-auma-one' | 'auma-subworkspace' | 'other' | 'unrecognised'; ambiguous: boolean } {
  const inner = /^--(.+)--$/.exec(dirName)?.[1]
  if (!inner) return { workspace: null, form: 'unrecognised', ambiguous: false }
  if (inner === 'dsh-home-auma') return { workspace: AUMA_ROOT, form: 'auma-root', ambiguous: false }
  if (inner === 'dsh-home-auma-one') return { workspace: '/dsh/home/auma-one', form: 'legacy-auma-one', ambiguous: false }
  if (inner.startsWith('dsh-home-auma-workspaces-')) {
    return { workspace: `${AUMA_ROOT}/workspaces/${inner.slice('dsh-home-auma-workspaces-'.length)}`, form: 'auma-subworkspace', ambiguous: false }
  }
  return { workspace: '/' + inner.replace(/-/g, '/'), form: 'other', ambiguous: inner.includes('-') }
}

export interface EstateCordisView {
  readonly activeFibers: ReadonlyArray<{ id: string; specifier: string; uid: number | null }>
  readonly fiberHealth: unknown
  readonly mountedOrgans: ReadonlyArray<{ name: string; sha256: string; updatedAt: number }>
  readonly registeredTools: readonly string[]
  readonly services: readonly string[]
  readonly head: { ballId: string; epoch: number; entries: number; modules: number }
}

export interface EstateProviders {
  readonly persistence?: () => Record<string, unknown>
  readonly persistenceInspect?: (limit: number) => Promise<Record<string, unknown>>
  readonly cordis?: () => EstateCordisView
}

export interface EstateRequest {
  readonly sections?: unknown
  readonly cursor?: unknown
  readonly limit?: unknown
  readonly root?: unknown
  readonly query?: unknown
  readonly maxHits?: unknown
  readonly perFileHashBytes?: unknown
}

const int = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(Math.max(value, min), max) : fallback

interface WalkNode { path: string; type: 'file' | 'dir'; size: number; mtimeMs: number }

function walk(vfs: MemoryVfs, root: string, limit: number): { nodes: WalkNode[]; truncated: boolean } {
  const nodes: WalkNode[] = []
  if (!vfs.existsSync(root)) return { nodes, truncated: false }
  const stack = [root]
  let truncated = false
  while (stack.length > 0) {
    const path = stack.pop() as string
    if (nodes.length >= limit) { truncated = true; break }
    let stat
    try { stat = vfs.statSync(path) as { size: number; mtimeMs: number; isDirectory(): boolean } } catch { continue }
    const dir = stat.isDirectory()
    nodes.push({ path, type: dir ? 'dir' : 'file', size: dir ? 0 : Number(stat.size), mtimeMs: Number(stat.mtimeMs) })
    if (!dir) continue
    let names: string[] = []
    try { names = vfs.readdirSync(path).map(String) } catch { continue }
    for (const name of names.sort().reverse()) stack.push(path === '/' ? `/${name}` : `${path}/${name}`)
  }
  nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { nodes, truncated }
}

const readBytes = (vfs: MemoryVfs, path: string): Uint8Array => {
  const raw = vfs.readFileSync(path)
  return typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
}

function vfsSection(vfs: MemoryVfs, request: EstateRequest): Record<string, unknown> {
  const root = typeof request.root === 'string' && (request.root === AUMA_ROOT || request.root.startsWith(AUMA_ROOT + '/'))
    && !request.root.includes('/../') && !request.root.endsWith('/..') ? request.root.replace(/\/+$/, '') : AUMA_ROOT
  const limit = int(request.limit, ESTATE_LIMITS.defaultPage, 1, ESTATE_LIMITS.maxPage)
  const cursor = int(request.cursor, 0, 0, ESTATE_LIMITS.walkNodes)
  const perFile = int(request.perFileHashBytes, ESTATE_LIMITS.perFileHashBytes, 0, ESTATE_LIMITS.maxPerFileHashBytes)
  const { nodes, truncated } = walk(vfs, root, ESTATE_LIMITS.walkNodes)
  let files = 0, dirs = 0, bytes = 0, privateFiles = 0, privateBytes = 0
  const workspaces = new Map<string, { files: number; bytes: number }>()
  for (const node of nodes) {
    if (node.type === 'dir') { dirs += 1; continue }
    files += 1; bytes += node.size
    if (estateRedaction(node.path) === 'private') { privateFiles += 1; privateBytes += node.size }
    const ws = /^\/dsh\/home\/auma\/workspaces\/([^/]+)\//.exec(node.path)?.[1]
    if (ws) {
      const item = workspaces.get(ws) ?? { files: 0, bytes: 0 }
      item.files += 1; item.bytes += node.size
      workspaces.set(ws, item)
    }
  }
  if (vfs.existsSync(`${AUMA_ROOT}/workspaces`)) {
    try { for (const name of vfs.readdirSync(`${AUMA_ROOT}/workspaces`).map(String)) if (!workspaces.has(name)) workspaces.set(name, { files: 0, bytes: 0 }) } catch { /* listed below as found */ }
  }
  let hashBudget = ESTATE_LIMITS.totalHashBytes
  // Inside the private tree only the root is listed (existence); its contents are counted above, never named or read.
  const listedNodes = nodes.filter(node => !node.path.startsWith(PRIVATE_ROOT + '/'))
  const entries = listedNodes.slice(cursor, cursor + limit).map((node) => {
    const redacted = estateRedaction(node.path)
    if (node.type === 'dir') return { path: node.path, type: 'dir' as const, ...(redacted ? { redacted } : {}) }
    if (redacted) return { path: node.path, type: 'file' as const, size: node.size, redacted, sha256: null }
    if (node.size > perFile) return { path: node.path, type: 'file' as const, size: node.size, mtimeMs: node.mtimeMs, sha256: null, digestSkipped: 'PER_FILE_HASH_LIMIT' }
    if (node.size > hashBudget) return { path: node.path, type: 'file' as const, size: node.size, mtimeMs: node.mtimeMs, sha256: null, digestSkipped: 'TOTAL_HASH_BUDGET' }
    try {
      const data = readBytes(vfs, node.path)
      hashBudget -= data.byteLength
      return { path: node.path, type: 'file' as const, size: data.byteLength, mtimeMs: node.mtimeMs, sha256: sha256HexSync(data) }
    } catch (error) {
      return { path: node.path, type: 'file' as const, size: node.size, sha256: null, digestSkipped: `READ_FAILED: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}` }
    }
  })
  const next = cursor + limit < listedNodes.length ? cursor + limit : null
  return {
    root, totals: { files, dirs, bytes, nodes: nodes.length, walkTruncated: truncated },
    private: { present: vfs.existsSync(PRIVATE_ROOT), files: privateFiles, bytes: privateBytes, policy: 'existence-and-size-only' },
    workspaces: [...workspaces].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, item]) => ({ name, path: `${AUMA_ROOT}/workspaces/${name}`, ...item })),
    page: { cursor, limit, returned: entries.length, nextCursor: next }, entries,
  }
}

interface SessionFile { path: string; dir: string; workspaceDir: string; size: number; mtimeMs: number }

function sessionFiles(vfs: MemoryVfs): { files: SessionFile[]; truncated: boolean } {
  const { nodes, truncated } = walk(vfs, SESSIONS_ROOT, ESTATE_LIMITS.walkNodes)
  const files: SessionFile[] = []
  for (const node of nodes) {
    if (node.type !== 'file' || !node.path.endsWith('.jsonl')) continue
    const rel = node.path.slice(SESSIONS_ROOT.length + 1).split('/')
    if (rel.length < 2) continue
    files.push({ path: node.path, dir: node.path.slice(0, node.path.lastIndexOf('/')), workspaceDir: rel[0] as string, size: node.size, mtimeMs: node.mtimeMs })
  }
  return { files, truncated }
}

function headerOf(vfs: MemoryVfs, path: string): Record<string, unknown> | null {
  try {
    const bytes = readBytes(vfs, path)
    const text = new TextDecoder().decode(bytes.subarray(0, ESTATE_LIMITS.sessionHeaderBytes))
    const first = text.split('\n')[0] ?? ''
    const parsed: unknown = JSON.parse(first)
    if (!record(parsed)) return null
    const out: Record<string, unknown> = {}
    for (const key of ['type', 'version', 'id', 'sessionId', 'title', 'cwd', 'workspace', 'createdAt', 'timestamp', 'mode', 'preset']) {
      const value = parsed[key]
      if (typeof value === 'string') out[key] = value.slice(0, 160)
      else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    }
    return out
  } catch { return null }
}

function sessionsSection(vfs: MemoryVfs): Record<string, unknown> {
  const { files, truncated } = sessionFiles(vfs)
  const byDir = new Map<string, SessionFile[]>()
  for (const file of files) byDir.set(file.dir, [...(byDir.get(file.dir) ?? []), file])
  const sessions = [...byDir].map(([dir, list]) => {
    const workspaceDir = list[0]?.workspaceDir ?? ''
    const decoded = decodeSessionWorkspace(workspaceDir)
    const main = list.find(file => /session\.v\d+\.jsonl$/.test(file.path)) ?? list[0] as SessionFile
    return {
      dir, workspaceDir, ...decoded, sessionId: dir.slice(dir.lastIndexOf('/') + 1),
      files: list.map(file => ({ name: file.path.slice(file.path.lastIndexOf('/') + 1), size: file.size })),
      bytes: list.reduce((total, file) => total + file.size, 0),
      mtimeMs: Math.max(...list.map(file => file.mtimeMs)),
      header: headerOf(vfs, main.path),
    }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const workspaces = new Map<string, { workspaceDir: string; workspace: string | null; form: string; sessions: number; bytes: number }>()
  for (const session of sessions) {
    const item = workspaces.get(session.workspaceDir)
      ?? { workspaceDir: session.workspaceDir, workspace: session.workspace, form: session.form, sessions: 0, bytes: 0 }
    item.sessions += 1; item.bytes += session.bytes
    workspaces.set(session.workspaceDir, item)
  }
  return {
    root: SESSIONS_ROOT, present: vfs.existsSync(SESSIONS_ROOT), walkTruncated: truncated,
    totals: { sessions: sessions.length, files: files.length, bytes: files.reduce((total, file) => total + file.size, 0) },
    workspaces: [...workspaces.values()],
    legacyDirsPresent: { '--dsh-home-auma-one--': workspaces.has('--dsh-home-auma-one--'), '--dsh-home-auma--': workspaces.has('--dsh-home-auma--') },
    sessions: sessions.slice(0, ESTATE_LIMITS.sessionsListed),
    sessionsTruncated: sessions.length > ESTATE_LIMITS.sessionsListed,
  }
}

function searchSection(vfs: MemoryVfs, request: EstateRequest): Record<string, unknown> {
  const query = typeof request.query === 'string' ? request.query : ''
  if (!query.trim() || query.length > ESTATE_LIMITS.queryChars) return { ok: false, code: 'ESTATE_QUERY_INVALID', maxChars: ESTATE_LIMITS.queryChars }
  const maxHits = int(request.maxHits, ESTATE_LIMITS.searchHits, 1, ESTATE_LIMITS.maxSearchHits)
  const needle = query.toLowerCase()
  const { files } = sessionFiles(vfs)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const hits: Array<Record<string, unknown>> = []
  let filesScanned = 0, bytesScanned = 0, truncated = false
  for (const file of files) {
    if (hits.length >= maxHits) { truncated = true; break }
    if (filesScanned >= ESTATE_LIMITS.searchFiles || bytesScanned + file.size > ESTATE_LIMITS.searchBytes) { truncated = true; break }
    filesScanned += 1
    bytesScanned += file.size
    let text: string
    try { text = new TextDecoder().decode(readBytes(vfs, file.path)) } catch { continue }
    const lower = text.toLowerCase()
    let at = lower.indexOf(needle)
    while (at >= 0 && hits.length < maxHits) {
      const line = text.slice(0, at).split('\n').length
      const start = Math.max(0, at - 80), end = Math.min(text.length, at + needle.length + 80)
      hits.push({ path: file.path, workspaceDir: file.workspaceDir, line, snippet: text.slice(start, end).replace(/\s+/g, ' ') })
      at = lower.indexOf(needle, at + needle.length)
    }
  }
  return { ok: true, query, hits, filesScanned, bytesScanned, truncated,
    limits: { files: ESTATE_LIMITS.searchFiles, bytes: ESTATE_LIMITS.searchBytes, hits: maxHits } }
}

function wasmSection(): Record<string, unknown> {
  return {
    pins: Object.entries(CELL_PINS).map(([cell, pin]) => ({ cell, sha256: pin.sha256, bytes: pin.bytes, fuel: pin.fuel,
      ops: pin.ops?.length ?? 0, ...(pin.maxRequestBytes ? { maxRequestBytes: pin.maxRequestBytes } : {}) })),
    limits: { cellMaxMemoryPages: CELL_MAX_MEMORY_PAGES, cellMaxMemoryBytes: CELL_MAX_MEMORY_PAGES * WASM_PAGE_BYTES,
      skillMaxMemoryPages: SKILL_MAX_MEMORY_PAGES, skillMaxFuel: SKILL_MAX_FUEL, browserFuelCap: CELL_BROWSER_FUEL_CAP,
      executionTimeoutMs: CELL_EXECUTION_TIMEOUT_MS },
  }
}

const shortValue = (value: unknown): unknown => typeof value === 'string' ? value.slice(0, 128)
  : typeof value === 'number' || typeof value === 'boolean' || value === null ? value : Array.isArray(value) ? `[array ${String(value.length)}]` : record(value) ? '[object]' : null

function receiptsSection(vfs: MemoryVfs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (vfs.existsSync(RECEIPTS_PATH)) {
    const text = new TextDecoder().decode(readBytes(vfs, RECEIPTS_PATH))
    let count = 0, invalid = 0, linked = true, contiguous = true, prevLeaf: string | null = null, prevSeq: number | null = null
    let firstSeq: number | null = null, lastSeq: number | null = null, lastLeafHash: string | null = null
    const kinds = new Map<string, number>()
    const promotions: Array<Record<string, unknown>> = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { invalid += 1; continue }
      if (!record(parsed)) { invalid += 1; continue }
      count += 1
      const seq = typeof parsed.seq === 'number' ? parsed.seq : null
      if (firstSeq === null) firstSeq = seq
      if (prevSeq !== null && seq !== prevSeq + 1) contiguous = false
      if (prevLeaf !== null && parsed.prevHash !== prevLeaf) linked = false
      prevSeq = seq; lastSeq = seq
      prevLeaf = typeof parsed.leafHash === 'string' ? parsed.leafHash : null
      lastLeafHash = prevLeaf
      const kind = typeof parsed.kind === 'string' ? parsed.kind.slice(0, 64) : '(none)'
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
      if ((kind === 'head.promote' || kind === 'ball.promote') && record(parsed.data)) {
        const d = parsed.data
        promotions.push({ seq, kind, epoch: shortValue(d.epoch), ballId: shortValue(d.ballId), entryId: shortValue(d.entryId),
          tier: shortValue(d.tier), hasApprovalToken: d.hasApprovalToken === true,
          operationId: shortValue(d.operationId ?? null), transitionKind: shortValue(d.transitionKind ?? null) })
      }
    }
    out.receipts = { path: RECEIPTS_PATH, bytes: text.length, count, invalidLines: invalid, firstSeq, lastSeq, lastLeafHash,
      structuralLinkage: linked && contiguous && invalid === 0 ? 'linked' : 'broken', note: 'Structural prevHash/seq linkage only; cryptographic verification is seed-receipts verify.',
      kinds: [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([kind, n]) => ({ kind, count: n })),
      // Lane E5 keep-authoritative: a provisional (no-token) leaf is shown as superseded once a token leaf exists for it.
      promotions: promotions.map(row => ({ ...row, supersededByAuthoritative: row.hasApprovalToken === false
        && promotions.some(other => other.hasApprovalToken === true
          && (other.epoch === row.epoch || other.ballId === row.ballId)) })).slice(-12) }
  } else out.receipts = { path: RECEIPTS_PATH, present: false }
  if (vfs.existsSync(CHECKPOINTS_PATH)) {
    const lines = new TextDecoder().decode(readBytes(vfs, CHECKPOINTS_PATH)).split('\n').filter(line => line.trim())
    let last: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(lines.at(-1) ?? 'null')
      if (record(parsed)) last = Object.fromEntries(Object.keys(parsed).sort().slice(0, 16).map(key => [key, shortValue(parsed[key])]))
    } catch { last = null }
    out.checkpoints = { path: CHECKPOINTS_PATH, count: lines.length, last }
  } else out.checkpoints = { path: CHECKPOINTS_PATH, present: false }
  return out
}

/**
 * Inspect the browser estate. Read-only and bounded.
 * @param vfs - this tab's filesystem.
 * @param request - sections (default: all but `search`, which needs `query`), paging and search terms.
 * @param providers - live runtime views (persistence, Cordis); absent providers report `available: false`.
 * @returns a JSON-safe report at most ESTATE_LIMITS.outputBytes long.
 */
export async function inspectBrowserEstate(vfs: MemoryVfs, request: EstateRequest = {},
  providers: EstateProviders = {}): Promise<Record<string, unknown>> {
  const requested = Array.isArray(request.sections) ? request.sections : null
  if (requested && requested.some(item => !(ESTATE_SECTIONS as readonly unknown[]).includes(item))) {
    return { ok: false, code: 'ESTATE_SECTION_UNKNOWN', sections: ESTATE_SECTIONS }
  }
  const sections = new Set<EstateSection>(requested ? requested as EstateSection[]
    : ESTATE_SECTIONS.filter(section => section !== 'search' || typeof request.query === 'string'))
  const report: Record<string, unknown> = { ok: true, schema: 'aukora.browser-estate.v1', readOnly: true, at: Date.now(),
    dependencies: { github: false, mac: false, network: false } }
  const guard = (name: string, run: () => unknown): void => {
    try { report[name] = run() } catch (error) { report[name] = { ok: false, code: 'ESTATE_SECTION_FAILED', error: (error instanceof Error ? error.message : String(error)).slice(0, 200) } }
  }
  if (sections.has('vfs')) guard('vfs', () => vfsSection(vfs, request))
  if (sections.has('sessions')) guard('sessions', () => sessionsSection(vfs))
  if (sections.has('search')) guard('search', () => searchSection(vfs, request))
  if (sections.has('persistence')) {
    try {
      report.persistence = {
        status: providers.persistence ? providers.persistence() : { available: false },
        queue: providers.persistenceInspect ? await providers.persistenceInspect(64) : { available: false },
      }
    } catch (error) { report.persistence = { ok: false, code: 'ESTATE_SECTION_FAILED', error: (error instanceof Error ? error.message : String(error)).slice(0, 200) } }
  }
  if (sections.has('cordis')) guard('cordis', () => providers.cordis ? providers.cordis() : { available: false })
  if (sections.has('wasm')) guard('wasm', wasmSection)
  if (sections.has('receipts')) guard('receipts', () => receiptsSection(vfs))
  return boundReport(report)
}

/** Trim the largest lists until the report fits; every trim is flagged. */
export function boundReport(report: Record<string, unknown>): Record<string, unknown> {
  const size = (): number => new TextEncoder().encode(JSON.stringify(report)).byteLength
  const trims: string[] = []
  for (let pass = 0; pass < 24 && size() > ESTATE_LIMITS.outputBytes; pass += 1) {
    const vfsReport = record(report.vfs) ? report.vfs : null
    const sessions = record(report.sessions) ? report.sessions : null
    const search = record(report.search) ? report.search : null
    const candidates: Array<[string, unknown[] | undefined, (next: unknown[]) => void]> = [
      ['vfs.entries', vfsReport && Array.isArray(vfsReport.entries) ? vfsReport.entries : undefined, (next) => {
        if (!vfsReport) return
        vfsReport.entries = next
        const page = record(vfsReport.page) ? vfsReport.page : {}
        const cursor = typeof page.cursor === 'number' ? page.cursor : 0
        vfsReport.page = { ...page, returned: next.length, nextCursor: cursor + next.length }
      }],
      ['sessions.sessions', sessions && Array.isArray(sessions.sessions) ? sessions.sessions : undefined, (next) => { if (sessions) { sessions.sessions = next; sessions.sessionsTruncated = true } }],
      ['search.hits', search && Array.isArray(search.hits) ? search.hits : undefined, (next) => { if (search) { search.hits = next; search.truncated = true } }],
    ]
    const largest = candidates.filter(([, list]) => list && list.length > 0)
      .sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length)[0]
    if (!largest) break
    const [name, list, set] = largest
    set((list as unknown[]).slice(0, Math.floor((list as unknown[]).length / 2)))
    if (!trims.includes(name)) trims.push(name)
  }
  if (trims.length) report.outputTrimmed = trims
  report.outputBytes = size()
  return report
}
