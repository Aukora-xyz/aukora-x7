/**
 * Thread sync, the reader half: readers that pull her threads.
 *
 * Runs once per page load, after idb-persist has attached her store and before her tree boots (worker-host.ts), and
 * ONLY when the page's boot document carried the switch as exactly `on` (`bootThreadSyncIfOn`, the thread sync switch): with the
 * switch unset nothing below runs, and the page loads exactly as main.
 * - The ROLE comes from local facts only (`persistence.hydration`, the facts attach already read: no new IndexedDB
 *   transaction, the thread sync), never from the edge's mode. A browser that never saved anything of its own is a
 *   READER in every mode and on every failure to read the mode when it holds her cloud's home (a revision above 0) or
 *   when her cloud did not confirm, at this boot, that her home is empty (unknown is not a writer):
 *   `persistence.readOnly` is set before any call of this module, and nothing here ever sets it back. Every other
 *   browser is left exactly as main leaves it.
 * - The MODE is the `sync` field of `GET /_thread/index` (`off`, `pull`, `on`). A missing field, any status but 200, a
 *   malformed body or no answer within 4 s read as `off`. Exactly one index GET at boot in every role; with `off` no
 *   thread, vault or lease call follows it. A browser that is not a reader never waits for it.
 * - A reader in `pull` or `on` pulls each index thread of 64 MiB or less into memory, newest first: the manifest, each
 *   sealed part from `/_vault/blob/<sha>` (its SHA-256 checked, the rolling chain checked against the manifest), then
 *   the open end by `tail` (checked against `tailSha`). A thread whose open end ends inside a line, or that fails any
 *   check, is not shown from the cloud (a named line is logged); the rest go on. A good thread is put in memory with
 *   `vfs.seed` only where that never shortens or rewrites a local file. Nothing is written to IndexedDB.
 * - Every request has a deadline and the whole pull has a 120 s budget; what did not fit stays in her cloud this load.
 * - While this page is a reader, the worker's fetch wrapper refuses every model door, every same-origin call that is
 *   not a GET or HEAD, and the GETs that change her node (`READER_REFUSED_GETS`), with the reader sentence
 *   (`readerRefusal`, the `the thread sync` block in worker-host.ts). The page and the edge refuse the same.
 * - The page hears the state on BroadcastChannel `aukora-x6-thread-sync`, each message carrying its page's id.
 * The writer half (her writer copies each line as it is written, mode `on`) is thread-writer.ts.
 * @module thread-sync
 */
import { idleFetch } from '../idle-fetch.ts'
import { isModelDoor, modelDoorFor } from '../model-doors.ts'
import { persistence as storePersistence } from './idb-persist.ts'
import { rollingChain, threadPathAllowed } from './thread-sync-plan.ts'
import type { HydrationFacts } from './idb-persist.ts'
import type {
  ThreadIndexEntry, ThreadLocalFacts, ThreadNet, ThreadNetReply, ThreadPersistenceView, ThreadStore, ThreadSyncMode,
  ThreadSyncRole, ThreadSyncStateMessage,
} from './thread-store-types.ts'

/** The channel the worker and the page share. */
export const THREAD_SYNC_CHANNEL = 'aukora-x6-thread-sync'

/** Deadlines, budgets and caps. Tests pass smaller ones; production uses these. */
export const THREAD_SYNC_LIMITS = Object.freeze({
  /** The boot index read: no answer in this long reads as `off`. */
  modeReadMs: 4_000,
  /** The whole pull, all threads together. */
  pullBudgetMs: 120_000,
  /** Any one request of the pull. */
  requestMs: 30_000,
  /** A reader pulls only threads of this size or less. */
  readerMaxThreadBytes: 64 * 1024 * 1024,
  /** All the threads one pull puts in memory, together; a thread that would pass it stays in her cloud this load. */
  readerTotalBytes: 128 * 1024 * 1024,
  /** Threads asked per index page, and pages read at most (2,048 threads is the edge's cap). */
  indexPageLimit: 200,
  indexPages: 11,
  /** The edge's largest tail answer. */
  tailMax: 262_144,
  /** Reply size caps, by kind. */
  indexBytes: 4 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  /** The footer, in characters. */
  footerChars: 200,
})
export type ThreadSyncLimits = { -readonly [K in keyof typeof THREAD_SYNC_LIMITS]: number }

/** The reader sentences (shared facts), exactly. */
export const READER_OLDER_FOOTER = 'Reading an older copy of her from her cloud. She answers in the browser that holds her home. Nothing typed here is saved.'
export const NONE_ON_FOOTER = 'This browser does not hold her home. Its new lines stay here.'

const HEX64 = /^[0-9a-f]{64}$/
const NEWLINE = 0x0a
const MODES: readonly ThreadSyncMode[] = ['off', 'pull', 'on']

// ---------------------------------------------------------------------------------------------------------------------
// The reader gate the worker's fetch wrapper reads (worker-host.ts, the `the thread sync` block).
// ---------------------------------------------------------------------------------------------------------------------

/** While this page is a reader, the sentence every refused call carries; null for every other page. */
export const threadReader: { footer: string | null } = { footer: null }

/**
 * Same-origin GETs that change her node at the edge (head-do.mjs: `promotion-status` can persist a
 * published epoch, `transcript` can cancel a stale turn). A reader never sends them; the page and the edge refuse them too.
 */
export const READER_REFUSED_GETS: readonly string[] = Object.freeze(['/_head/promotion-status', '/_head/transcript'])

/**
 * Whether the fetch wrapper refuses this call, and with what sentence. Null (the call goes on unchanged) whenever this
 * page is not a reader. As a reader: every URL that `modelDoorFor` sends to a door, every `/door/` URL, and every
 * same-origin request whose method is not GET or HEAD is refused with the reader footer.
 * @param url - The URL string the wrapper classifies.
 * @param origin - This worker's origin.
 * @param method - The request method (the init's, else the Request's, else GET).
 * @returns The refusal sentence, or null.
 */
export function readerRefusal(url: string, origin: string, method: string | undefined): string | null {
  const footer = threadReader.footer
  if (footer === null) return null
  let target: URL
  try { target = new URL(url, origin) } catch { return footer }
  const door = modelDoorFor(url, origin)
  if (door === null || door !== url || isModelDoor(target.href, origin)) return footer
  const verb = (method ?? 'GET').toUpperCase()
  if (target.origin === origin && verb !== 'GET' && verb !== 'HEAD') return footer
  if (target.origin === origin && READER_REFUSED_GETS.includes(target.pathname)) return footer
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Local facts and the mode.
// ---------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * What attach's hydration facts say about this browser. "Saved before": a stored
 * `seq` above 0, a queued batch, a reconciliation marker (a save that hit a cloud hold writes its rows and the marker
 * but not meta, so seq stays 0), paths held back (queued-batch paths, waiting journals, local removals), or stored rows
 * with no meta at all (positive evidence of local work is never made read-only). Otherwise it never saved, and:
 * the local transport is `local`; her cloud confirming at THIS boot that her home is empty (revision 0, and none stored
 * above 0) is `empty-node`, a new world, as main; a revision above 0, stored or answered, is `never-saved-cloud-home`;
 * anything else (no answer at this boot, an answer the stored fence does not match) is `unconfirmed`. No facts at all
 * (no IndexedDB, or attach did not run) is `unknown`, and the caller does what main does.
 * @param hydration - `persistence.hydration`.
 * @returns The local facts.
 */
export function localFactsFromHydration(hydration: HydrationFacts | null | undefined): ThreadLocalFacts {
  if (!isRecord(hydration)) return 'unknown'
  if (hydration.transport === 'local') return 'local'
  const seq = hydration.seq === null ? null : count(hydration.seq)
  const queued = count(hydration.queuedBatches) ?? 0
  const held = count(hydration.heldPaths) ?? 0
  if ((seq ?? 0) > 0 || queued > 0 || held > 0 || hydration.reconciliation) return 'saved-before'
  if (hydration.storedRows && hydration.seq === null) return 'saved-before'
  const stored = hydration.storedRevision === null ? null : count(hydration.storedRevision)
  const answered = hydration.cloudRevision === null ? null : count(hydration.cloudRevision)
  if ((stored ?? 0) > 0 || (answered ?? 0) > 0) return 'never-saved-cloud-home'
  if (hydration.cloud === 'confirmed' && answered === 0) return 'empty-node'
  return 'unconfirmed'
}

/** The role from the local facts alone: a browser that never saved and is not proven to hold an empty new world reads. */
export const roleOf = (facts: ThreadLocalFacts): ThreadSyncRole =>
  (facts === 'never-saved-cloud-home' || facts === 'unconfirmed' ? 'reader' : 'none')

/** One parsed index page. */
interface IndexPage {
  readonly mode: ThreadSyncMode
  readonly threads: readonly ThreadIndexEntry[]
  readonly next: string | null
  readonly holder: string | null
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const jsonOf = (bytes: Uint8Array): unknown => {
  try { return JSON.parse(decoder.decode(bytes)) as unknown } catch { return undefined }
}
const timeOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The holder's label, when the index shows a live lease: control characters dropped, 60 characters at most. */
function holderOf(lease: unknown): string | null {
  if (!isRecord(lease) || lease.live !== true || typeof lease.label !== 'string') return null
  let plain = ''
  for (let index = 0; index < lease.label.length; index += 1) {
    const code = lease.label.charCodeAt(index)
    if (code >= 0x20 && code !== 0x7f) plain += lease.label[index] ?? ''
  }
  plain = plain.trim()
  if (plain === '') return null
  return plain.length > 60 ? `${plain.slice(0, 59)}…` : plain
}

/**
 * Parse one `GET /_thread/index` answer. Any status but 200 or a body that is not an index answer is null; a body
 * whose `sync` is not one of the three words reads as mode `off`.
 */
export function parseIndexPage(reply: Pick<ThreadNetReply, 'status' | 'bytes'>): IndexPage | null {
  if (reply.status !== 200) return null
  const body = jsonOf(reply.bytes)
  if (!isRecord(body) || !Array.isArray(body.threads)) return null
  const mode = typeof body.sync === 'string' && (MODES as readonly string[]).includes(body.sync) ? body.sync as ThreadSyncMode : 'off'
  const threads: ThreadIndexEntry[] = []
  for (const row of body.threads) {
    if (!isRecord(row) || typeof row.id !== 'string' || !HEX64.test(row.id) || typeof row.path !== 'string') continue
    const bytes = count(row.bytes)
    if (bytes === null) continue
    threads.push({
      id: row.id,
      path: row.path,
      bytes,
      activeAt: timeOf(row.activeAt),
      updatedAt: timeOf(row.updatedAt),
      title: plainOf(row.title, TITLE_CHARS),
      preview: plainOf(row.preview, PREVIEW_CHARS),
    })
  }
  const next = typeof body.next === 'string' && HEX64.test(body.next) ? body.next : null
  return { mode, threads, next, holder: holderOf(body.lease) }
}

// ---------------------------------------------------------------------------------------------------------------------
// The network: same-origin GETs, each with a deadline and a size cap.
// ---------------------------------------------------------------------------------------------------------------------

const NO_ANSWER = (): ThreadNetReply => ({ status: 0, headers: new Headers(), bytes: new Uint8Array(0) })

/** Read a body to its end, or stop (and cancel) past `cap` bytes. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > cap) { void reader.cancel().catch(() => {}); return null }
    chunks.push(part.value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return out
}

/**
 * Her edge, from this worker: `origin + path`, GET, same-origin credentials, no cache. The deadline covers the headers
 * and the whole body; silence for the same time also ends it (idleFetch, whose bytes the boot page counts). A reply
 * over `maxBytes`, a network error or a deadline is status 0.
 * @param origin - This worker's origin.
 */
export function edgeNet(origin: string): ThreadNet {
  return {
    async get(path, deadlineMs, maxBytes = THREAD_SYNC_LIMITS.indexBytes) {
      if (!(deadlineMs > 0)) return NO_ANSWER()
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort(new Error('THREAD_READ_DEADLINE')) }, deadlineMs)
      try {
        const response = await idleFetch(`${origin}${path}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal },
          { idleMs: deadlineMs, code: 'THREAD_READ_STALLED', what: 'her threads', fetchImpl: (input, init) => globalThis.fetch(input, init) })
        const bytes = await readCapped(response, maxBytes)
        return bytes === null ? NO_ANSWER() : { status: response.status, headers: response.headers, bytes }
      } catch {
        return NO_ANSWER()
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// One thread from her cloud.
// ---------------------------------------------------------------------------------------------------------------------

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const sha256Hex = async (bytes: Uint8Array): Promise<string> => toHex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))

/** Why a thread is not shown from the cloud; `outOfTime` stops the whole pull; `overRoom`: it did not fit this load. */
class PullStop extends Error {
  constructor(readonly reason: string, readonly outOfTime = false, readonly overRoom = false) { super(reason) }
}

/** The manifest's thread row, with only the fields the pull reads. */
interface ManifestThread {
  readonly path: string
  readonly piece: number
  readonly bytes: number
  readonly lineEnd: number
  readonly sealedBytes: number
  readonly partCount: number
  readonly chain: string
  readonly tailSha: string
}

function manifestThread(body: unknown): { thread: ManifestThread; parts: string[]; pages: number } | null {
  if (!isRecord(body) || !isRecord(body.thread) || !Array.isArray(body.parts)) return null
  const t = body.thread
  const piece = count(t.piece), bytes = count(t.bytes), lineEnd = count(t.lineEnd), sealedBytes = count(t.sealedBytes)
  const partCount = count(t.partCount), pages = count(body.pages)
  if (piece === null || piece < 1 || bytes === null || lineEnd === null || sealedBytes === null) return null
  if (partCount === null || pages === null) return null
  if (typeof t.path !== 'string' || typeof t.chain !== 'string' || !HEX64.test(t.chain) || typeof t.tailSha !== 'string' || !HEX64.test(t.tailSha)) return null
  if (sealedBytes !== partCount * piece || bytes < sealedBytes || lineEnd > bytes) return null
  const parts = body.parts.filter((name): name is string => typeof name === 'string' && HEX64.test(name))
  if (parts.length !== body.parts.length) return null
  return { thread: { path: t.path, piece, bytes, lineEnd, sealedBytes, partCount, chain: t.chain, tailSha: t.tailSha }, parts, pages }
}

interface PullContext {
  readonly net: ThreadNet
  readonly limits: ThreadSyncLimits
  readonly now: () => number
  readonly deadline: number
}

/** One GET of the pull: its deadline is the request limit or what is left of the budget, whichever is less. */
async function ask(ctx: PullContext, path: string, maxBytes: number): Promise<ThreadNetReply> {
  const left = ctx.deadline - ctx.now()
  if (left <= 0) throw new PullStop('the time for this load ran out', true)
  const reply = await ctx.net.get(path, Math.min(ctx.limits.requestMs, left), maxBytes)
  if (reply.status === 0 && ctx.deadline - ctx.now() <= 0) throw new PullStop('the time for this load ran out', true)
  return reply
}

/**
 * Read one thread whole from her cloud and check it: every sealed part by its SHA-256 and the rolling chain against
 * the manifest, the open end against `tailSha`, whole lines only. A thread that ends inside a line keeps `[0, lineEnd)`
 * when that line end lies in the sealed parts (every kept byte is checked by its part); when the torn line starts in
 * the open end it is not shown, because `tail` never answers bytes past `lineEnd` and so the open end cannot be checked
 * against `tailSha`. The last byte kept must be a newline. Returns its bytes, or throws a PullStop naming why it is not
 * shown. `room` is what the pull may still hold in memory.
 */
async function pullOne(ctx: PullContext, entry: ThreadIndexEntry, room: number): Promise<Uint8Array> {
  const first = await ask(ctx, `/_thread/manifest?id=${entry.id}&page=0`, ctx.limits.manifestBytes)
  if (first.status !== 200) throw new PullStop(`its manifest answered ${String(first.status)}`)
  const head = manifestThread(jsonOf(first.bytes))
  if (head === null) throw new PullStop('its manifest is not readable')
  const t = head.thread
  if (t.path !== entry.path) throw new PullStop('its manifest names another path')
  if (t.bytes > ctx.limits.readerMaxThreadBytes) throw new PullStop('it grew past the size a reader pulls')
  if (t.bytes > room) throw new PullStop('it grew past what this load may hold', false, true)
  const torn = t.lineEnd < t.bytes
  if (torn && t.lineEnd > t.sealedBytes) throw new PullStop('its open end ends inside a line')
  if (torn && t.lineEnd === 0) throw new PullStop('it holds no whole line yet')
  const names = [...head.parts]
  for (let page = 1; names.length < t.partCount && page < head.pages; page += 1) {
    const more = await ask(ctx, `/_thread/manifest?id=${entry.id}&page=${String(page)}`, ctx.limits.manifestBytes)
    const sheet = more.status === 200 ? manifestThread(jsonOf(more.bytes)) : null
    if (sheet === null) throw new PullStop(`page ${String(page)} of its manifest is not readable`)
    if (sheet.thread.bytes !== t.bytes || sheet.thread.chain !== t.chain || sheet.thread.tailSha !== t.tailSha) throw new PullStop('it moved while it was read')
    names.push(...sheet.parts)
  }
  if (names.length < t.partCount) throw new PullStop('its list of parts is shorter than its count')
  const parts = names.slice(0, t.partCount)
  // Torn here means the last whole line ends inside the sealed parts: only they are read, and the open end is dropped.
  const out = new Uint8Array(torn ? t.sealedBytes : t.bytes)
  for (const [k, name] of parts.entries()) {
    const blob = await ask(ctx, `/_vault/blob/${name}`, t.piece + 1)
    if (blob.status !== 200) throw new PullStop(`part ${String(k + 1)} of ${String(t.partCount)} answered ${String(blob.status)}`)
    if (blob.bytes.byteLength !== t.piece || await sha256Hex(blob.bytes) !== name) throw new PullStop(`part ${String(k + 1)} of ${String(t.partCount)} does not hash to its name`)
    out.set(blob.bytes, k * t.piece)
  }
  if (await rollingChain(parts) !== t.chain) throw new PullStop('the chain of its parts does not match its manifest')
  if (torn) {
    const kept = out.slice(0, t.lineEnd)
    if (kept[kept.byteLength - 1] !== NEWLINE) throw new PullStop('its last byte is not a line end')
    return kept
  }
  // The open end, backwards in whole-line steps; only bytes at or past the sealed parts are taken from each answer.
  // A line in the open end longer than one `tail` answer cannot be read this way (the edge answers up to the line end
  // before it): the thread is then not shown, and stays in her cloud.
  for (let before = t.bytes; before > t.sealedBytes;) {
    const got = await ask(ctx, `/_thread/tail?id=${entry.id}&before=${String(before)}&max=${String(ctx.limits.tailMax)}`, ctx.limits.tailMax + 1)
    if (got.status !== 200) throw new PullStop(`its open end answered ${String(got.status)}`)
    const from = Number(got.headers.get('x-thread-from')), to = Number(got.headers.get('x-thread-to'))
    const asked = Number.isSafeInteger(from) && Number.isSafeInteger(to) && to === before && from >= 0 && from < before
    if (!asked || got.bytes.byteLength !== to - from) {
      throw new PullStop('its open end was not answered as asked')
    }
    const start = Math.max(from, t.sealedBytes)
    out.set(got.bytes.subarray(start - from), start)
    before = from
  }
  if (await sha256Hex(out.subarray(t.sealedBytes, t.bytes)) !== t.tailSha) throw new PullStop('its open end does not match its SHA-256')
  if (out.byteLength > 0 && out[out.byteLength - 1] !== NEWLINE) throw new PullStop('its last byte is not a line end')
  return out
}

const asBytes = (value: string | Uint8Array): Uint8Array => (typeof value === 'string' ? new TextEncoder().encode(value) : value)

/**
 * Put a pulled thread in memory only where that never shortens or rewrites a local file: no local file, or a local
 * file the pulled bytes extend. Silent (`vfs.seed` publishes no mutation) and never persisted.
 * @returns What happened: `seeded`, `same` (already equal), or `kept` (the local copy stays, and is not touched).
 */
export function seedPulled(store: ThreadStore, path: string, bytes: Uint8Array, mtimeMs: number | null): 'seeded' | 'same' | 'kept' {
  try {
    if (store.existsSync(path)) {
      if (!store.statSync(path).isFile()) return 'kept'
      const local = asBytes(store.readFileSync(path))
      if (local.byteLength > bytes.byteLength) return 'kept'
      for (let index = 0; index < local.byteLength; index += 1) if (local[index] !== bytes[index]) return 'kept'
      if (local.byteLength === bytes.byteLength) return 'same'
    }
    store.seed(path, bytes, mtimeMs === null ? {} : { mtimeMs })
    return 'seeded'
  } catch {
    return 'kept'
  }
}

/** What a pull did, thread by thread. */
export interface ThreadPullReport {
  /** Threads in the index that a reader pulls (allowed path, not empty, 64 MiB or less). */
  readonly wanted: number
  readonly seeded: string[]
  readonly same: string[]
  readonly kept: string[]
  /** `path: why` for each thread not shown from the cloud. */
  readonly failed: string[]
  /** Threads above the reader's size: they stay in her cloud. */
  readonly long: number
  /** Threads the budget did not reach this load. */
  readonly leftForLater: number
  /** Threads that would have taken this load past `readerTotalBytes` in memory: they stay in her cloud. */
  readonly overRoom: number
  /** The index was not read to its end (a page not read, or the time ran out while listing). */
  readonly incomplete: boolean
}

/** Threads the reader wanted and does not show from her cloud this load (failed, out of time, out of room). */
export const unreadThreads = (report: ThreadPullReport): number => report.failed.length + report.leftForLater + report.overRoom

/**
 * Pull every thread a reader shows, newest first, into memory. Never throws; every request has a deadline and the
 * whole pull has `limits.pullBudgetMs`.
 */
export async function pullThreads(options: {
  readonly net: ThreadNet
  readonly store: ThreadStore
  readonly first: IndexPage
  readonly limits?: Partial<ThreadSyncLimits>
  readonly now?: () => number
  readonly onThread?: (done: number, total: number) => void
  readonly log?: (line: string) => void
}): Promise<ThreadPullReport> {
  const limits: ThreadSyncLimits = { ...THREAD_SYNC_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => { console.warn(line) })
  const ctx: PullContext = { net: options.net, limits, now, deadline: now() + limits.pullBudgetMs }
  const report = { wanted: 0, seeded: [] as string[], same: [] as string[], kept: [] as string[], failed: [] as string[],
    long: 0, leftForLater: 0, overRoom: 0, incomplete: false }
  // What this pull has put in memory so far (seeded threads only: a thread read and not seeded is let go).
  let held = 0
  try {
    const listed = [...options.first.threads]
    let next = options.first.next
    for (let page = 1; next !== null && page < limits.indexPages; page += 1) {
      const reply = await ask(ctx, `/_thread/index?after=${next}&limit=${String(limits.indexPageLimit)}`, limits.indexBytes)
      const more = parseIndexPage(reply)
      if (more === null) { report.incomplete = true; log(`thread-sync: page ${String(page + 1)} of her thread index was not read; its threads stay in her cloud this load`); break }
      listed.push(...more.threads)
      next = more.next
    }
    if (next !== null) report.incomplete = true
    const shown = listed.filter(entry => threadPathAllowed(entry.path) && entry.bytes > 0)
    const wanted = shown.filter(entry => entry.bytes <= limits.readerMaxThreadBytes)
    report.long = shown.length - wanted.length
    report.wanted = wanted.length
    const when = (entry: ThreadIndexEntry): number => entry.activeAt ?? entry.updatedAt ?? 0
    wanted.sort((a, b) => when(b) - when(a))
    for (const [index, entry] of wanted.entries()) {
      try {
        // A thread that would take this load past its memory budget is not asked for; a smaller, older one still is.
        if (held + entry.bytes > limits.readerTotalBytes) throw new PullStop('it does not fit in what this load may hold', false, true)
        const bytes = await pullOne(ctx, entry, limits.readerTotalBytes - held)
        const done = seedPulled(options.store, entry.path, bytes, entry.activeAt ?? entry.updatedAt ?? null)
        report[done === 'seeded' ? 'seeded' : done === 'same' ? 'same' : 'kept'].push(entry.path)
        if (done === 'seeded') held += bytes.byteLength
        if (done === 'kept') log(`thread-sync: ${entry.path} differs from this browser's copy; this browser's copy is shown and kept`)
      } catch (error) {
        const stop = error instanceof PullStop ? error : new PullStop(error instanceof Error ? error.message : String(error))
        if (stop.outOfTime) {
          report.leftForLater = wanted.length - index
          log(`thread-sync: the time for reading her threads ran out; ${String(report.leftForLater)} stay in her cloud this load`)
          break
        }
        if (stop.overRoom) {
          report.overRoom += 1
          log(`thread-sync: ${entry.path} stays in her cloud this load: ${stop.reason}`)
        } else {
          report.failed.push(`${entry.path}: ${stop.reason}`)
          log(`thread-sync: ${entry.path} is not shown from her cloud: ${stop.reason}`)
        }
      }
      options.onThread?.(index + 1, wanted.length)
    }
  } catch (error) {
    // Only the listing can throw here (each thread's own stop is caught above): her index was not read to its end.
    report.incomplete = true
    if (!(error instanceof PullStop && error.outOfTime)) log(`thread-sync: reading her threads stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
  return report
}

/**
 * Whether a pull may claim a fresh read ("read at HH:MM"). Only when her index was read to its end
 * and at least one conversation was verified from her cloud, or her index was read whole and lists none at all.
 * Anything else (nothing verified, only long threads, an index not read to its end) shows the older-copy sentence.
 */
export function pullIsFresh(report: ThreadPullReport): boolean {
  if (report.incomplete) return false
  const verified = report.seeded.length + report.same.length
  if (verified > 0) return true
  return report.wanted === 0 && report.long === 0 && report.failed.length === 0 && report.leftForLater === 0 && report.overRoom === 0
}

/** CARD 3a: how long a title and a preview may be, after control characters are dropped (the edge cuts the same way). */
const TITLE_CHARS = 200
const PREVIEW_CHARS = 160

// `plainOf` is a function declaration so `parseIndexPage` above can use it wherever it is written in this module.
/** A string as the lane may show it: printable characters only, trimmed, cut to `chars`; null when nothing is left. */
function plainOf(value: unknown, chars: number): string | null {
  if (typeof value !== 'string') return null
  let plain = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0x20 && code !== 0x7f) plain += value[index] ?? ''
  }
  plain = plain.trim()
  if (plain === '') return null
  return plain.length > chars ? `${plain.slice(0, chars - 1)}…` : plain
}

/** CARD 3a: one conversation as her cloud's index names it, for the page's list (never the page's own state). */
export interface ThreadCloudRow {
  readonly id: string
  readonly path: string
  readonly bytes: number
  readonly activeAt: number | null
  /** The index's own title (her writer sends one with `x-thread-meta`); null before it has. */
  readonly title: string | null
  /** Bytes of the journal this browser holds for it; null when it holds none. */
  readonly local: number | null
  /** Over the size a reader pulls, so it is listed here and not read (card 3b opens it). */
  readonly long: boolean
}

/** The rows message: the channel the state uses, a kind of its own, so `parseThreadSyncState` never sees it. */
export interface ThreadCloudRowsMessage {
  readonly v: 1
  readonly kind: 'rows'
  readonly at: number
  readonly mode: ThreadSyncMode
  readonly rows: readonly ThreadCloudRow[]
  readonly worker?: string
}

/** What this browser holds for one path, in bytes: null when it holds no journal there. Never a write, never a guess. */
function localBytes(store: ThreadStore, path: string): number | null {
  try {
    if (!store.existsSync(path)) return null
    const stat = store.statSync(path) as { isFile(): boolean; size?: number | bigint }
    if (!stat.isFile() || stat.size === undefined) return null
    return Number(stat.size)
  } catch {
    return null
  }
}

/** The SESSION id in one `/dsh/home/sessions/<project>/<id>/session.vN.jsonl` path, decoded; null for every other path. */
export function sessionOf(path: string): string | null {
  const parts = path.split('/')
  if (parts.length < 4) return null
  if (!/^session\.v\d+\.jsonl$/u.test(parts[parts.length - 1] ?? '')) return null
  // Her private folder is refused by `x6/thread-reader.ts` and is never listed here either.
  if ((parts[parts.length - 3] ?? '').toLowerCase().includes('private')) return null
  const raw = parts[parts.length - 2] ?? ''
  if (raw === '' || raw === '.' || raw === '..') return null
  // `encodeSegment` (session-persistence-jsonl `format.ts`) escapes anything outside [A-Za-z0-9._-] as `~XXXX`.
  const id = raw.replace(/~([0-9A-F]{4})/gu, (_all: string, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return id === '' ? null : id
}

/**
 * CARD 3a: the page's list of every conversation her index holds, built from the index rows themselves rather than
 * from the journals this browser happens to hold. `local` is this browser's own byte count for the same path, so the
 * lane can mark an older copy here without deleting it.
 *
 * `ad872eb2`: `id` is the SESSION id read from the path, never the thread id (`entry.id` is sha256 of the path).
 * The lane joins on a SessionId; joining on the thread id marked every conversation here "only in this browser" and
 * every index row cloud-only.
 *
 * `825b17e5`: a row whose path this build cannot name (the legacy `messages.jsonl` layout) is carried with an
 * EMPTY id rather than dropped: the page then knows a row exists that it cannot match, so it withholds the one claim it
 * must never make wrongly ("only in this browser") instead of making it on partial evidence.
 */
export function cloudRows(entries: readonly ThreadIndexEntry[], limits: ThreadSyncLimits, store: ThreadStore): ThreadCloudRow[] {
  const rows: ThreadCloudRow[] = []
  for (const entry of entries) {
    const session = sessionOf(entry.path)
    rows.push({
      id: session ?? '',
      path: entry.path,
      bytes: entry.bytes,
      activeAt: entry.activeAt ?? entry.updatedAt ?? null,
      title: entry.title ?? null,
      local: localBytes(store, entry.path),
      long: entry.bytes > limits.readerMaxThreadBytes,
    })
  }
  return rows
}

/** How much of the end of an appended span the meta scan reads, and how many rows of it it looks at. */
const META_SCAN_BYTES = 65536
const META_SCAN_ROWS = 400
/** The wire's own bounds (thread-log.mjs `metaHeader`): base64url without padding, 4,096 characters at most. */
const META_HEADER_MAX = 4096
const META_TITLE_CHARS = 120
const META_PREVIEW_CHARS = 120

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const squashText = (value: string): string => value.replace(/\s+/gu, ' ').trim()

/** His or her words in one row, joined; null when the row carries none. */
function rowText(data: Record<string, unknown>): string | null {
  const message = isRecordLike(data.message) ? data.message : data
  if (!Array.isArray(message.content)) return null
  const parts: string[] = []
  for (const block of message.content) {
    if (isRecordLike(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length === 0 ? null : squashText(parts.join(' '))
}

/**
 * CARD 3a: the `x-thread-meta` header for one append, read from the span being appended — the newest `session/title`
 * in it and the newest words, so her cloud's index can name and time a conversation nobody here has pulled. The wire is
 * the edge's (`deploy/cloudflare/src/thread-log.mjs` `metaHeader`): base64url without padding of
 * `{title?, preview?, activeAt}`, those keys only, 4,096 characters at most. The scan is the last 64 KiB of the span
 * and 400 rows, so an append of hundreds of MiB costs what a small one does. A span with neither sends only `activeAt`
 * and her cloud keeps whatever title it has; anything unexpected in the encoding sends no header at all.
 * @param body - The journal bytes this append sends.
 * @param at - The time this append is written (the row's `activeAt`).
 * @returns The headers to add, or an empty object.
 */
export function threadMetaHeader(body: Uint8Array, at: number): Record<string, string> {
  let title: string | null = null
  let preview: string | null = null
  let newest: number | null = null
  try {
    const lines = new TextDecoder().decode(body.subarray(Math.max(0, body.byteLength - META_SCAN_BYTES))).split('\n')
    // A window that does not start at the span's beginning may cut its first line: one odd line is skipped, not fatal.
    let looked = 0
    for (let index = lines.length - 1; index >= 0 && looked < META_SCAN_ROWS; index -= 1, looked += 1) {
      const line = lines[index] ?? ''
      if (line.length < 2 || !line.startsWith('{"type":"')) continue
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      if (!isRecordLike(row) || typeof row.type !== 'string' || !isRecordLike(row.data)) continue
      // Her own row time is the honest `activeAt`: a span sent now can have been written long ago (a backfill), and
      // calling that conversation active now would put "Active just now" on one nobody touched.
      if (newest === null && typeof row.time === 'number' && Number.isSafeInteger(row.time) && row.time > 0) newest = row.time
      if (row.type === 'session/title') {
        if (title === null && typeof row.data.title === 'string') title = squashText(row.data.title).slice(0, META_TITLE_CHARS) || null
      } else if (preview === null && (row.type === 'assistant/message' || row.type === 'user/message')) {
        const words = rowText(row.data)
        if (words !== null && words !== '') preview = words.slice(0, META_PREVIEW_CHARS)
      }
      if (title !== null && preview !== null) break
    }
  } catch {
    return {}
  }
  try {
    const meta: Record<string, string | number> = { activeAt: newest === null ? at : Math.min(at, newest) }
    if (title !== null) meta.title = title
    if (preview !== null) meta.preview = preview
    let binary = ''
    for (const byte of new TextEncoder().encode(JSON.stringify(meta))) binary += String.fromCharCode(byte)
    const encoded = btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
    return encoded.length > META_HEADER_MAX ? {} : { 'x-thread-meta': encoded }
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Footers and the channel.
// ---------------------------------------------------------------------------------------------------------------------

const clock = (ms: number): string => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * The reader's footer after a pull (shared facts), 200 characters at most. `longThreads` are above the size
 * a reader pulls; `unread` were wanted and not shown this load (a failed check, the time or the memory budget). When
 * all that stay are long the sentence says "long"; when any is not, it counts them all plainly.
 */
export function readerPulledFooter(at: number, holder: string | null, longThreads: number, unread = 0): string {
  const answers = holder === null ? 'She answers in the browser that holds her home.' : `She answers in ${holder}.`
  const stay = Math.max(0, longThreads) + Math.max(0, unread)
  const kind = unread > 0 ? '' : 'long '
  const tail = stay === 0 ? '' : stay === 1 ? ` 1 ${kind}thread stays in her cloud.` : ` ${String(stay)} ${kind}threads stay in her cloud.`
  return `Reading her from her cloud, read at ${clock(at)}. ${answers} Nothing typed here is saved.${tail}`.slice(0, THREAD_SYNC_LIMITS.footerChars)
}

/** The smallest face of BroadcastChannel this module uses. */
export interface ThreadSyncChannel {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
  close?(): void
}

const defaultChannel = (): ThreadSyncChannel | null => {
  try {
    const Channel = (globalThis as { BroadcastChannel?: new (name: string) => ThreadSyncChannel }).BroadcastChannel
    return typeof Channel === 'function' ? new Channel(THREAD_SYNC_CHANNEL) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// What this page load says about thread sync (x6_self_state `threadSync`), one object for the worker.
// ---------------------------------------------------------------------------------------------------------------------

/** `x6_self_state` `threadSync`: this page load's thread sync, read only. `sent`/`pending` count whole lines. */
export interface ThreadSyncSelfState {
  mode: ThreadSyncMode | null
  role: ThreadSyncRole | null
  sent: number
  /** HER SENDER (Card 1.5): the journal bytes her cloud accepted from this browser this page load (APPLIED only, so a
   * lower bound in the same sense as `sent`). The daily byte allowance is in bytes, and this is the only counter the
   * lane and `x6_self_state` can show for it. */
  bytes: number
  /** Whole lines the planner has counted as unsent this load: exact for every conversation it has looked at, and 0 for
   * one it never reached, so it is never on its own the predicate for "everything is in her cloud". */
  pending: number
  /** CARD 1.5: bytes on disk that no acknowledgement covers, measured from file sizes and the receipts. THIS answers "is
   * anything still only in this browser"; `pending` is the planner's line count. */
  pendingBytes: number
  lastOkAtMs: number | null
  lastError: string | null
}

/** This worker's thread sync facts; thread-writer.ts updates `sent`, `pending`, `lastOkAtMs`, `lastError` and `role`. */
export const threadSyncState: ThreadSyncSelfState = { mode: null, role: null, sent: 0, bytes: 0, pending: 0, pendingBytes: 0, lastOkAtMs: null, lastError: null }

/** A copy of the facts, for `x6_self_state` (never the live object). */
export const threadSyncSelfState = (): ThreadSyncSelfState => ({ ...threadSyncState })

// ---------------------------------------------------------------------------------------------------------------------
// The switch as this page's boot document carried it.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Whether thread sync is switched on for this page load. Her edge says so only in the boot document it serves (the
 * `<meta name="aukora-thread-sync" content="on">` it adds when `THREAD_SYNC` is exactly `on`; client/reader-window.ts
 * `servedThreadSync` reads it, the init frame carries `threadSync: 'on'`, worker-host.ts passes it here). Anything else
 * (no meta: the switch unset, `pull`, `off`, a typo, or an old document from before the meta existed) leaves it false,
 * and then nothing of thread sync runs: no role, no read-only, no mark, no index read, no writer, no `threadSync` key in
 * `x6_self_state`. Set once per page load by `bootThreadSyncIfOn`.
 */
export const threadSyncSwitch: { on: boolean } = { on: false }

/** The exact word that switches thread sync on; every other value is off. */
export const THREAD_SYNC_ON = 'on'

/** `x6_self_state`'s `threadSync` field: present only while thread sync is switched on (an empty object otherwise). */
export const threadSyncSelfStateField = (): { threadSync?: ThreadSyncSelfState } =>
  (threadSyncSwitch.on ? { threadSync: threadSyncSelfState() } : {})

// ---------------------------------------------------------------------------------------------------------------------
// The boot entry (worker-host.ts, between attachIdbPersistence and her tree's boot).
// ---------------------------------------------------------------------------------------------------------------------

/** What the boot decided, for the host and the tests. */
export interface ThreadSyncBoot {
  readonly facts: ThreadLocalFacts
  readonly role: ThreadSyncRole
  /** The hydration facts the role came from (null when attach recorded none). */
  readonly hydration: HydrationFacts | null
  /** Settles when the index read (and, for a reader, the pull) is over; it never rejects. A reader's boot awaited it. */
  readonly settled: Promise<{ mode: ThreadSyncMode; report: ThreadPullReport | null }>
  /** The latest state posted, or null while nothing was posted. */
  latest(): ThreadSyncStateMessage | null
  /** Post a state on this page's channel (her writer's footers); the reader's own posts go through it too. */
  publish(mode: ThreadSyncMode, footer: string, role?: ThreadSyncRole): void
}

export interface ThreadSyncBootOptions {
  readonly vfs: ThreadStore
  readonly persistence?: ThreadPersistenceView
  /** This worker's origin; default `location.origin`. Without one, nothing is read and the mode is `off`. */
  readonly origin?: string | null
  readonly net?: ThreadNet
  readonly now?: () => number
  readonly limits?: Partial<ThreadSyncLimits>
  /** Called when a reader starts pulling, and after each thread with its count (the boot page's phase, "N of M"). */
  readonly enter?: (of?: readonly [done: number, total: number]) => void
  readonly channel?: () => ThreadSyncChannel | null
  readonly log?: (line: string) => void
  /** The id this worker's page gave it at init; every message carries it so a page shows only its own worker's line. */
  readonly pageId?: string | null
}

const PAGE_ID = /^[0-9a-f]{16,64}$/

/**
 * Decide this page's role from attach's hydration facts (no IndexedDB call, no network), make a reader read-only and
 * tell the page before any call, read the mode once, and (reader, mode `pull` or `on`) pull her threads into memory
 * before the tree boots. Only a reader's boot waits; for any other page this returns at once, and the index read goes
 * on without being awaited. Never throws.
 */
export async function bootThreadSync(options: ThreadSyncBootOptions): Promise<ThreadSyncBoot> {
  const persistence = options.persistence ?? storePersistence
  const limits: ThreadSyncLimits = { ...THREAD_SYNC_LIMITS, ...options.limits }
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => { console.warn(line) })
  let hydration: HydrationFacts | null = null
  try { hydration = persistence.hydration } catch { hydration = null }
  const facts = localFactsFromHydration(hydration)
  const role = roleOf(facts)
  threadSyncState.role = role
  threadSyncState.mode = null
  if (role === 'reader') {
    // R3: before any call of this module, and nothing here ever sets it back.
    persistence.readOnly = true
    threadReader.footer = READER_OLDER_FOOTER
  }
  const worker = typeof options.pageId === 'string' && PAGE_ID.test(options.pageId) ? options.pageId : null
  let latest: ThreadSyncStateMessage | null = null
  let channel: ThreadSyncChannel | null = null
  const answer = (event: { data: unknown }): void => {
    const data = event.data
    // Review SHOULD 1: only this page's own ask is answered (its id, or no id from a page that gave none), so another
    // tab's ask never makes this page re-set the browser-wide reader mark.
    if (!isRecord(data) || data.v !== 1 || data.kind !== 'ask' || data.worker !== (worker ?? undefined)) return
    try {
      if (latest !== null) channel?.postMessage(latest)
    } catch { /* the page is gone */ }
  }
  const send = (message: ThreadSyncStateMessage): void => {
    try {
      channel ??= (options.channel ?? defaultChannel)()
      if (channel === null) return
      channel.onmessage ??= answer
      channel.postMessage(message)
    } catch { /* no channel in this engine: the footer stays in the worker */ }
  }
  /**
   * CARD 3a: `rows` ride INSIDE the state message, beside `footer`, for two reasons the closed spec and the boot both
   * insist on: a reader's boot posts exactly one state before the pull and one after it, and a page's own ask is
   * answered with ONE message. A second message kind would be a second post to count and one a page can miss.
   */
  const publish = (mode: ThreadSyncMode, footer: string, as: ThreadSyncRole = role, rows?: readonly ThreadCloudRow[]): void => {
    const message: ThreadSyncStateMessage & { rows?: readonly ThreadCloudRow[] } = {
      v: 1,
      kind: 'state',
      at: now(),
      mode,
      role: as,
      footer: footer.slice(0, limits.footerChars),
      ...(worker === null ? {} : { worker }),
      ...(rows === undefined ? {} : { rows }),
    }
    latest = message
    send(message)
  }
  // MUST 2: the page hears that it is a reader before the first call, so its own controls (and the mark the edge reads)
  // refuse at once, not after the pull.
  if (role === 'reader') publish('off', READER_OLDER_FOOTER)
  const origin = options.origin === undefined ? (globalThis as { location?: { origin?: string } }).location?.origin ?? null : options.origin
  const net = options.net ?? (origin === null ? null : edgeNet(origin))

  const work = (async (): Promise<{ mode: ThreadSyncMode; report: ThreadPullReport | null }> => {
    try {
      const reply = net === null ? NO_ANSWER() : await net.get(`/_thread/index?limit=${String(limits.indexPageLimit)}`, limits.modeReadMs, limits.indexBytes)
      const page = parseIndexPage(reply)
      const mode: ThreadSyncMode = page?.mode ?? 'off'
      threadSyncState.mode = mode
      if (role !== 'reader') {
        // A browser that is not a reader posts nothing here (her writer, thread-writer.ts, posts its own). Unknown local
        // facts in mode `on` are told plainly; nothing is posted while the mode is off.
        if (facts === 'unknown' && mode !== 'off') publish(mode, mode === 'on' ? NONE_ON_FOOTER : '')
        return { mode, report: null }
      }
      if (page === null || mode === 'off' || net === null) {
        publish(mode, READER_OLDER_FOOTER)
        return { mode, report: null }
      }
      options.enter?.()
      const report = await pullThreads({ net, store: options.vfs, first: page, limits, now, log,
        onThread: (done, total) => { options.enter?.([done, total]) } })
      // MUST 4: a fresh read is claimed only when her index was read whole and a conversation was verified from it.
      const footer = pullIsFresh(report) ? readerPulledFooter(now(), page.holder, report.long, unreadThreads(report)) : READER_OLDER_FOOTER
      threadReader.footer = footer
      // CARD 3a: the list facts ride in this state message, and only when her index was read WHOLE (`next` null and no
      // stop): a first page out of several would make the lane call a conversation "only in this browser" that her index
      // lists further on, which is the one claim this card must never make wrongly. Without a list the lane draws what
      // it drew before.
      const whole = page.next === null && !report.incomplete
      publish(mode, footer, undefined, whole ? cloudRows(page.threads, limits, options.vfs) : undefined)
      return { mode, report }
    } catch (error) {
      log(`thread-sync: ${error instanceof Error ? error.message : String(error)}`)
      if (role === 'reader') publish('off', READER_OLDER_FOOTER)
      return { mode: 'off', report: null }
    }
  })()
  if (role === 'reader') await work
  return { facts, role, hydration, settled: work, latest: () => latest, publish }
}

/**
 * The boot entry worker-host.ts calls: `bootThreadSync` exactly as built when the boot document carried
 * the switch as exactly `on`; otherwise null at once, with nothing read, set, posted or asked (the page loads as main).
 * @param served - What the init frame carried (`threadSync`); only the exact string `on` switches it on.
 * @returns The boot, or null while thread sync is switched off for this page load.
 */
export async function bootThreadSyncIfOn(served: unknown, options: ThreadSyncBootOptions): Promise<ThreadSyncBoot | null> {
  threadSyncSwitch.on = served === THREAD_SYNC_ON
  if (!threadSyncSwitch.on) return null
  return await bootThreadSync(options)
}
