/**
 * Thread sync, job 2: her ONE writer browser copies each thread's new lines to her cloud as they are
 * written, so "Copy to her cloud" and "Join her threads" on `/rescue` stop being the daily path (they stay, as the
 * fallback). Started by worker-host.ts after her tree is up; it never runs while the mode is not `on`.
 *
 * Who writes (BRIEF-SYNC A3, built here on attach's hydration facts, with no new IndexedDB call):
 * 1. this browser saved her before (`saved-before`), its stored fence was CONFIRMED by her cloud at this boot (the cloud
 *    has not moved since this browser's last acknowledged save: a stale browser is `diverged`), its stored `seq` is above
 *    0, and it has a mirror client id;
 * 2. the newest thread in her cloud's index that this browser also holds was last written by this client id
 *    (`thread.run.client` on page 0 of its manifest), or her cloud holds none that this browser holds;
 * 3. the Web Lock `aukora-x6-thread-writer` is free (one tab of this browser at a time; no lock API, no writer);
 * 4. before EVERY append: `persistence.conflict` and `persistence.localSave.error` are null and the store is not read-only.
 * Any of 1 to 3 failing: role `none` for this page load, no lease, no append, and the page is told so in mode `on`.
 *
 * What it sends (A1, A2, A4): it reads journals through the VFS only (`stat`, and `read` only when the size grew) and
 * never writes, seeds or deletes. A thread her cloud holds is extended only when this browser's bytes are PROVEN to
 * extend the cloud's (chain and tail hashes, thread-sync-plan `localFacts`); a thread her cloud lacks is created only
 * at 8 MiB or less (a larger one waits for Join); a file shorter than her cloud's copy, or one that does not extend it,
 * gets no call at all (never a retract, never a pull) and is counted. Only bytes unchanged for ROLLBACK_SETTLE_MS are
 * sent, whole lines where a line fits a body, 2 MiB a body at most, one request per tick (2 s). Each append names its
 * offset (`at`), what it extends (`x-thread-have`) and its SHA-256: it is idempotent by line position, so a lost answer
 * is retried at the same `at` and answered ALREADY. The cursor is her cloud's own answer (APPLIED or ALREADY) and is
 * read again from her index after a reload: it is resumable with nothing stored here.
 *
 * Bounds: one request at a time, each with a deadline; 409 re-reads her index once, never resends blind (a second 409
 * on the same thread holds that thread for this load); 413 halves the body; 429, 503, 507, 401 and silence back off
 * (2 s doubling to 60 s); 410 drops the lease, waits 60 s and acquires again (three in ten minutes stop it for this
 * load); 423 waits and names who holds her. Nothing here is awaited by a turn, a save or the boot.
 * @module thread-writer
 */
import type { HydrationFacts } from './idb-persist.ts'
import {
  classifyThreadReply, halve, lastLineEnd, localFacts, ROLLBACK_SETTLE_MS, THREAD_PIECE, threadIdFor, threadPathAllowed, ZERO_CHAIN,
} from './thread-sync-plan.ts'
import { localFactsFromHydration, NONE_ON_FOOTER, threadSyncState, type ThreadSyncBoot } from './thread-sync.ts'
import type { ThreadNetReply, ThreadPersistenceView, ThreadReadStore, ThreadSyncMode } from './thread-store-types.ts'

/** The SHA-256 of zero bytes: the open end of a thread her cloud does not hold yet. */
export const EMPTY_TAIL_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
/** The Web Lock one writer tab holds. */
export const THREAD_WRITER_LOCK = 'aukora-x6-thread-writer'
/** The lease label her cloud shows other browsers (world-lease.mjs: 80 printable characters at most). */
export const THREAD_WRITER_LABEL = 'Her browser'

export const THREAD_WRITER_LIMITS = Object.freeze({
  /** One request per tick at most (A4). */
  tickMs: 2_000,
  /** One body at most (A4), never above the edge's piece. */
  bodyBytes: 2 * 1024 * 1024,
  /** A thread her cloud lacks is created by this browser only at this size or less (A2); a larger one waits for Join. */
  createMaxBytes: 8 * 1024 * 1024,
  /** Renew the lease this long after its last grant (world-lease TTL is 90 s). */
  renewMs: 30_000,
  /** Any one request. */
  requestMs: 30_000,
  backoffMinMs: 2_000,
  backoffMaxMs: 60_000,
  /** After a 410 (her turn ran out) or a 423 (another browser holds her). */
  goneWaitMs: 60_000,
  goneMax: 3,
  goneWindowMs: 600_000,
  indexPageLimit: 200,
  indexPages: 11,
  indexBytes: 4 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  replyBytes: 64 * 1024,
})
export type ThreadWriterLimits = { -readonly [K in keyof typeof THREAD_WRITER_LIMITS]: number }

/** Her edge, as the writer speaks to it. Never rejects: no answer, a deadline or an oversized reply is status 0. */
export interface ThreadWriterNet {
  get(path: string, deadlineMs: number, maxBytes?: number): Promise<ThreadNetReply>
  post(path: string, body: Uint8Array | string, headers: Readonly<Record<string, string>>, deadlineMs: number): Promise<ThreadNetReply>
}

/** The smallest face of the Web Locks API the writer uses. */
export interface ThreadWriterLocks {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<void>): Promise<unknown>
}

const NO_ANSWER = (): ThreadNetReply => ({ status: 0, headers: new Headers(), bytes: new Uint8Array(0) })

/** Read a body to its end, or stop past `cap` bytes. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  return bytes.byteLength > cap ? null : bytes
}

/** Her edge, from this worker: same-origin, no cache, each call with its own deadline. */
export function writerNet(origin: string, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): ThreadWriterNet {
  const call = async (path: string, init: RequestInit, deadlineMs: number, maxBytes: number): Promise<ThreadNetReply> => {
    if (!(deadlineMs > 0)) return NO_ANSWER()
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('THREAD_WRITE_DEADLINE')) }, deadlineMs)
    try {
      const response = await fetchImpl(`${origin}${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      const bytes = await readCapped(response, maxBytes)
      return bytes === null ? NO_ANSWER() : { status: response.status, headers: response.headers, bytes }
    } catch {
      return NO_ANSWER()
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    get: (path, deadlineMs, maxBytes = THREAD_WRITER_LIMITS.indexBytes) => call(path, { method: 'GET' }, deadlineMs, maxBytes),
    post: (path, body, headers, deadlineMs) => call(path, { method: 'POST', headers: { ...headers }, body: body as BodyInit }, deadlineMs, THREAD_WRITER_LIMITS.replyBytes),
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const NEWLINE = 0x0a
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const decoder = new TextDecoder('utf-8', { fatal: true })
const jsonOf = (bytes: Uint8Array): unknown => { try { return JSON.parse(decoder.decode(bytes)) as unknown } catch { return undefined } }
const linesIn = (bytes: Uint8Array): number => { let n = 0; for (const byte of bytes) if (byte === NEWLINE) n += 1; return n }
const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const sha256Hex = async (bytes: Uint8Array): Promise<string> => toHex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
const clock = (ms: number): string => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** What her cloud holds of one thread, as the index or an APPLIED/ALREADY answer says. */
interface CloudRow {
  id: string
  bytes: number
  lineEnd: number
  sealedBytes: number
  chain: string
  tailSha: string
  activeAt: number
}

/** One cloud pair out of an index row or an append answer; null when it is not that shape. */
function cloudRowOf(id: string, body: unknown, piece: number, activeAt = 0): CloudRow | null {
  if (!isRecord(body) || !uint(body.bytes) || !uint(body.lineEnd) || typeof body.chain !== 'string' || !HEX64.test(body.chain)
    || typeof body.tailSha !== 'string' || !HEX64.test(body.tailSha)) return null
  const sealedBytes = uint(body.sealedBytes) ? body.sealedBytes : uint(body.partCount) ? body.partCount * piece : null
  if (sealedBytes === null || sealedBytes > body.bytes || sealedBytes % piece !== 0) return null
  return { id, bytes: body.bytes, lineEnd: body.lineEnd, sealedBytes, chain: body.chain, tailSha: body.tailSha, activeAt }
}

/** What the writer knows of one local journal between ticks. */
interface LocalTrack {
  size: number
  changedAt: number
  /** Full-piece hashes of the bytes last read (thread-sync-plan `cachedParts`). */
  parts: readonly string[]
  /** Whole lines here that her cloud is not proven to hold (as of the last read). */
  pendingLines: number
  /** Why this thread gets no call, or null. Planned again only when its size changes, unless `final`. */
  held: string | null
  /** The size it was held at. */
  heldAt: number
  /** Held for the rest of this page load (her cloud refused it, or answered 409 twice). */
  final: boolean
  /** 409s in a row on this thread (a second one holds it). */
  conflicts: number
}

/** What one step did, for the loop and the tests. */
export type ThreadWriterStep =
  | 'stopped' | 'waiting' | 'store-held' | 'paused' | 'lease-refused' | 'lease-lost' | 'cloud-silent'
  | 'idle' | 'appended' | 'already' | 'replan' | 'smaller' | 'backoff' | 'thread-held'

export interface ThreadWriterOptions {
  readonly vfs: ThreadReadStore
  readonly persistence: ThreadPersistenceView
  readonly net: ThreadWriterNet
  readonly boot: Pick<ThreadSyncBoot, 'publish'>
  readonly now?: () => number
  readonly limits?: Partial<ThreadWriterLimits>
  readonly piece?: number
  readonly tabId?: string
  readonly log?: (line: string) => void
  readonly roots?: readonly string[]
}

/** The writer, driven by `step()` (one unit of work) or `run()` (steps on a timer until stopped). */
export interface ThreadWriter {
  step(): Promise<ThreadWriterStep>
  run(sleep?: (ms: number) => Promise<void>): Promise<void>
  stop(reason?: string): Promise<void>
  /** The footer the page was last told. */
  footer(): string | null
}

/** All journal paths under `/dsh/home` that the thread routes carry, sorted. Reads directories only. */
export function localThreadPaths(vfs: ThreadReadStore, home = '/dsh/home'): string[] {
  const out: string[] = []
  const names = (dir: string): string[] => {
    try { return vfs.existsSync(dir) && vfs.statSync(dir).isDirectory() ? vfs.readdirSync(dir).map(String) : [] } catch { return [] }
  }
  for (const project of names(`${home}/sessions`)) {
    for (const id of names(`${home}/sessions/${project}`)) {
      for (const file of names(`${home}/sessions/${project}/${id}`)) {
        const path = `${home}/sessions/${project}/${id}/${file}`
        if (threadPathAllowed(path)) out.push(path)
      }
    }
  }
  for (const name of names(home)) {
    const path = `${home}/${name}/session/messages.jsonl`
    if (threadPathAllowed(path)) { try { if (vfs.existsSync(path)) out.push(path) } catch { /* not there */ } }
  }
  return [...new Set(out)].sort()
}

/**
 * Whether this page may be her writer, from facts alone (A3 (1)): saved before, its fence confirmed by her cloud at this
 * boot, a stored seq above 0, and a client id. The index (2) and the lock (3) are checked by `startThreadWriter`.
 */
export function writerEligible(hydration: HydrationFacts | null | undefined): { ok: true; clientId: string } | { ok: false; why: string } {
  if (localFactsFromHydration(hydration) !== 'saved-before' || !hydration) return { ok: false, why: 'this browser has not saved her before' }
  if (hydration.cloud !== 'confirmed') return { ok: false, why: `her cloud did not confirm this browser's last save at this boot (${hydration.cloud})` }
  if (hydration.seq === null || hydration.seq <= 0) return { ok: false, why: 'this browser has no acknowledged save of its own' }
  if (hydration.clientId === null || hydration.clientId === '') return { ok: false, why: 'this browser has no mirror client id' }
  return { ok: true, clientId: hydration.clientId }
}

/** A random page-load id in the lease's tab alphabet. */
const mintTabId = (): string => {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return toHex(bytes.buffer)
}

/**
 * Build her writer (it does nothing until `step()` or `run()`). The caller has checked `writerEligible`, the mode and
 * the lock; `step()` checks the store before every append, the mode before every acquire and renew.
 */
export function createThreadWriter(options: ThreadWriterOptions & { clientId: string; cloud: Map<string, CloudRow> }): ThreadWriter {
  const limits: ThreadWriterLimits = { ...THREAD_WRITER_LIMITS, ...options.limits }
  const piece = options.piece ?? THREAD_PIECE
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => { console.warn(line) })
  const tabId = options.tabId ?? mintTabId()
  const { net, persistence, vfs, clientId } = options
  const cloud = options.cloud
  const local = new Map<string, LocalTrack>()
  let lease: { leaseId: string; generation: number; grantedAt: number } | null = null
  let waitUntil = 0
  let backoff = limits.backoffMinMs
  let bodyBytes = Math.min(limits.bodyBytes, piece)
  let needIndex = false
  let stopped: string | null = null
  const isStopped = (): boolean => stopped !== null
  const gone: number[] = []
  let lastFooter: string | null = null
  let footerKind: 'ok' | 'paused' | 'refused' | 'silent' | 'store' = 'ok'
  let holderLabel: string | null = null

  const say = (mode: ThreadSyncMode): void => {
    const pendingLines = [...local.values()].reduce((sum, track) => sum + track.pendingLines, 0)
    const rolledBack = [...local.values()].filter(track => track.held !== null && track.held.startsWith('rolled back')).length
    threadSyncState.pending = pendingLines
    const last = threadSyncState.lastOkAtMs
    let footer: string
    if (footerKind === 'paused') footer = 'Copying to her cloud is paused. New lines stay in this browser.'
    else if (footerKind === 'refused') footer = `She is answering in ${holderLabel ?? 'another browser'}. This browser's new lines stay here.`
    else if (footerKind === 'silent') footer = 'Her cloud did not answer. New lines stay in this browser and are sent when it does.'
    else if (footerKind === 'store') footer = 'Copying to her cloud is paused. New lines stay in this browser.'
    else if (rolledBack > 0) footer = rolledBack === 1 ? '1 conversation stopped copying and needs your card.' : `${String(rolledBack)} conversations stopped copying and need your card.`
    else if (pendingLines > 0) footer = `Only in this browser: ${String(pendingLines)} ${pendingLines === 1 ? 'line' : 'lines'}.${last === null ? '' : ` Last in her cloud ${clock(last)}.`}`
    else footer = `In her cloud ${clock(last ?? now())}.`
    if (footer === lastFooter) return
    lastFooter = footer
    options.boot.publish(mode, footer, footerKind === 'paused' ? 'none' : 'writer')
  }
  const fail = (why: string, ms: number, kind: typeof footerKind = 'silent'): void => {
    threadSyncState.lastError = why
    footerKind = kind
    waitUntil = now() + ms
  }
  const backOff = (why: string): ThreadWriterStep => {
    fail(why, backoff)
    backoff = Math.min(backoff * 2, limits.backoffMaxMs)
    return 'backoff'
  }

  /** The mode, read again before each acquire and renew (A3b): any answer but `on` is a pause. */
  const modeNow = async (): Promise<ThreadSyncMode | null> => {
    const reply = await net.get('/_thread/index?limit=1', limits.requestMs, limits.indexBytes)
    if (reply.status !== 200) return null
    const body = jsonOf(reply.bytes)
    return isRecord(body) && (body.sync === 'on' || body.sync === 'pull' || body.sync === 'off') ? body.sync : 'off'
  }
  const leaseCall = (action: 'acquire' | 'renew' | 'release') => net.post('/_mirror/lease', JSON.stringify({ action, clientId, tabId,
    label: THREAD_WRITER_LABEL, ...(action === 'acquire' || lease === null ? {} : { leaseId: lease.leaseId }) }),
  { 'content-type': 'application/json' }, limits.requestMs)
  const release = async (): Promise<void> => {
    if (lease === null) return
    await leaseCall('release')
    lease = null
  }
  const granted = (reply: ThreadNetReply): { leaseId: string; generation: number } | null => {
    const body = jsonOf(reply.bytes)
    const given = reply.status === 200 && isRecord(body) && isRecord(body.lease) ? body.lease : null
    return given && typeof given.leaseId === 'string' && HEX32.test(given.leaseId) && uint(given.generation) && given.generation >= 1
      ? { leaseId: given.leaseId, generation: given.generation } : null
  }
  const lostTurn = (): ThreadWriterStep => {
    lease = null
    const at = now()
    gone.push(at)
    while (gone.length > 0 && (gone[0] ?? 0) < at - limits.goneWindowMs) gone.shift()
    if (gone.length >= limits.goneMax) {
      stopped = 'her turn was lost three times in ten minutes; copying stops for this page load'
      fail(stopped, limits.goneWaitMs)
      return 'stopped'
    }
    fail('her turn at her cloud ran out; asking again in a minute', limits.goneWaitMs)
    return 'lease-lost'
  }

  /** Acquire or renew when due (and read the mode first). Null when this step may go on to an append. */
  const keepTurn = async (): Promise<ThreadWriterStep | null> => {
    const due = lease === null || now() - lease.grantedAt >= limits.renewMs
    if (!due) return null
    const mode = await modeNow()
    if (mode === null) return backOff('her cloud did not answer the mode read')
    threadSyncState.mode = mode
    if (mode !== 'on') {
      await release()
      fail('copying to her cloud is turned off at her edge', limits.renewMs, 'paused')
      say(mode)
      return 'paused'
    }
    const reply = await leaseCall(lease === null ? 'acquire' : 'renew')
    const given = granted(reply)
    if (given !== null) {
      lease = { ...given, grantedAt: now() }
      if (footerKind === 'refused' || footerKind === 'paused') footerKind = 'ok'
      return null
    }
    if (reply.status === 410) return lostTurn()
    if (reply.status === 423) {
      lease = null
      const body = jsonOf(reply.bytes)
      const label = isRecord(body) && isRecord(body.holder) && typeof body.holder.label === 'string' ? body.holder.label : null
      holderLabel = label === null ? null : label.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').slice(0, 60)
      fail(`another browser holds her turn${holderLabel === null ? '' : ` (${holderLabel})`}`, limits.goneWaitMs, 'refused')
      say('on')
      return 'lease-refused'
    }
    return backOff(`her turn could not be taken (${String(reply.status)})`)
  }

  /** Read her whole index again (after a 409, or when it is not known). */
  const readIndex = async (): Promise<boolean> => {
    let after = ''
    const seen = new Map<string, CloudRow>()
    for (let page = 0; page < limits.indexPages; page += 1) {
      const reply = await net.get(`/_thread/index?limit=${String(limits.indexPageLimit)}${after === '' ? '' : `&after=${after}`}`, limits.requestMs, limits.indexBytes)
      const body = reply.status === 200 ? jsonOf(reply.bytes) : undefined
      if (!isRecord(body) || !Array.isArray(body.threads)) return false
      for (const row of body.threads as unknown[]) {
        if (!isRecord(row) || typeof row.id !== 'string' || !HEX64.test(row.id) || typeof row.path !== 'string') continue
        const parsed = cloudRowOf(row.id, row, piece, typeof row.activeAt === 'number' ? row.activeAt : 0)
        if (parsed !== null) seen.set(row.path, parsed)
      }
      if (typeof body.next !== 'string' || !HEX64.test(body.next)) {
        cloud.clear()
        for (const [path, row] of seen) cloud.set(path, row)
        return true
      }
      after = body.next
    }
    return false
  }

  /** The next append for one path, or null (with the track updated). Reads the file only when its size grew. */
  type Plan = { from: number; to: number; bytes: Uint8Array; create: boolean; have: string }
  const planFor = async (path: string, at: number): Promise<Plan | null> => {
    let size: number
    try {
      const stat = vfs.statSync(path)
      if (!stat.isFile()) return null
      size = Number(stat.size)
    } catch { return null }
    const track: LocalTrack = local.get(path)
      ?? { size: -1, changedAt: at, parts: [], pendingLines: 0, held: null, heldAt: -1, final: false, conflicts: 0 }
    if (track.size !== size) { track.size = size; track.changedAt = at }
    local.set(path, track)
    if (track.final || (track.held !== null && track.heldAt === size)) return null
    track.held = null
    const row = cloud.get(path) ?? null
    if (row !== null && size === row.bytes) { track.pendingLines = 0; return null }
    if (row !== null && size < row.bytes) {
      // Shorter than her cloud's copy: this browser rolled lines back, or another wrote more. No call (A2).
      track.held = 'rolled back or behind her cloud'
      track.heldAt = size
      track.pendingLines = 0
      return null
    }
    if (at - track.changedAt < ROLLBACK_SETTLE_MS) return null
    if (row === null && size > limits.createMaxBytes) {
      track.held = 'waits for Join'
      track.heldAt = size
      track.pendingLines = 1
      threadSyncState.lastError = `a conversation of ${String(Math.round(size / 1_048_576))} MB is not in her cloud yet; Join on /rescue sends it`
      return null
    }
    let bytes: Uint8Array
    try {
      const read = vfs.readFileSync(path)
      bytes = typeof read === 'string' ? new TextEncoder().encode(read) : read
    } catch { return null }
    if (bytes.byteLength !== size) return null
    if (row === null) {
      const end = lastLineEnd(bytes)
      track.pendingLines = linesIn(bytes.subarray(0, end))
      return end === 0 ? null : { from: 0, to: end, bytes, create: true, have: `${ZERO_CHAIN}.${EMPTY_TAIL_SHA}` }
    }
    const facts = await localFacts(bytes, { bytes: row.bytes, lineEnd: row.lineEnd, sealedBytes: row.sealedBytes, chain: row.chain,
      tailSha: row.tailSha, piece }, { cachedParts: track.parts })
    track.parts = facts.parts
    if (!facts.extendsCloud) {
      track.held = 'rolled back or forked from her cloud'
      track.heldAt = size
      track.pendingLines = 0
      return null
    }
    track.pendingLines = linesIn(bytes.subarray(row.bytes, facts.lineEnd))
    return facts.lineEnd > row.bytes ? { from: row.bytes, to: facts.lineEnd, bytes, create: false, have: `${row.chain}.${row.tailSha}` } : null
  }

  /** One body out of [from, to): at most `bodyBytes`, cut at the last line end inside it when one is there. */
  const sliceOf = (bytes: Uint8Array, from: number, to: number): number => {
    const limit = Math.min(to, from + bodyBytes)
    if (limit === to) return to
    const cut = bytes.subarray(from, limit).lastIndexOf(NEWLINE)
    return cut >= 0 ? from + cut + 1 : limit
  }

  const step = async (): Promise<ThreadWriterStep> => {
    if (stopped !== null) return 'stopped'
    const at = now()
    if (at < waitUntil) return 'waiting'
    // A3 (4): never while this browser's own store is held, read-only or in conflict.
    if (persistence.readOnly || (persistence.conflict ?? null) !== null || (persistence.localSave?.error ?? null) !== null) {
      fail('this browser\'s own store is held; copying waits until it saves again', limits.backoffMaxMs, 'store')
      say('on')
      return 'store-held'
    }
    if (footerKind === 'store') footerKind = 'ok'
    const turn = await keepTurn()
    if (turn !== null) return turn
    if (needIndex) {
      if (!await readIndex()) return backOff('her thread index could not be read')
      needIndex = false
    }
    let chosen: Plan | null = null
    let chosenPath = ''
    // One append per step: the first path (sorted) with whole lines to send; the rest are planned on later steps.
    for (const path of localThreadPaths(vfs)) {
      const plan = await planFor(path, at)
      if (plan !== null) { chosen = plan; chosenPath = path; break }
    }
    if (chosen === null || lease === null) {
      if (footerKind !== 'refused') footerKind = 'ok'
      say('on')
      return 'idle'
    }
    const to = sliceOf(chosen.bytes, chosen.from, chosen.to)
    const body = chosen.bytes.slice(chosen.from, to)
    const id = await threadIdFor(chosenPath)
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-thread-lease': `${lease.leaseId}.${String(lease.generation)}`,
      'x-thread-have': chosen.have,
      'x-thread-sha256': await sha256Hex(body),
      ...(chosen.create ? { 'x-thread-path': chosenPath } : {}),
    }
    const reply = await net.post(`/_thread/append?p=1&id=${id}&at=${String(chosen.from)}`, body, headers, limits.requestMs)
    const answer = jsonOf(reply.bytes)
    const code = isRecord(answer) && typeof answer.code === 'string' ? answer.code : null
    const kind = classifyThreadReply(reply.status, code)
    const track = local.get(chosenPath)
    if (kind === 'done') {
      const row = cloudRowOf(id, answer, piece, at)
      if (row === null) { needIndex = true; return backOff('her cloud answered an append in a shape this page cannot read') }
      cloud.set(chosenPath, row)
      if (track) track.conflicts = 0
      backoff = limits.backoffMinMs
      if (code === 'APPLIED') threadSyncState.sent += linesIn(body)
      threadSyncState.lastOkAtMs = now()
      threadSyncState.lastError = null
      footerKind = 'ok'
      if (track) track.pendingLines = Math.max(0, track.pendingLines - linesIn(body))
      say('on')
      return code === 'APPLIED' ? 'appended' : 'already'
    }
    if (kind === 'resend-from' || kind === 'locate' || reply.status === 409) {
      // Never resend blind: read her index once and plan again; a second 409 in a row holds this thread for this load.
      needIndex = true
      threadSyncState.lastError = `her cloud answered ${code ?? '409'} for one conversation; reading her index again`
      if (track === undefined) return 'replan'
      track.conflicts += 1
      if (track.conflicts < 2) return 'replan'
      track.held = `her cloud answered ${code ?? '409'} twice`
      track.final = true
      log(`thread-writer: ${chosenPath} held for this load: ${track.held}`)
      return 'thread-held'
    }
    if (kind === 'reader') {
      if (reply.status === 423) {
        lease = null
        fail('another browser holds her turn', limits.goneWaitMs, 'refused')
        say('on')
        return 'lease-refused'
      }
      return lostTurn()
    }
    if (kind === 'smaller') { bodyBytes = halve(bodyBytes); return 'smaller' }
    if (kind === 'held') {
      if (track) { track.held = `her cloud refused it (${code ?? String(reply.status)})`; track.final = true }
      threadSyncState.lastError = `her cloud refused one conversation (${code ?? String(reply.status)}); it stays in this browser`
      return 'thread-held'
    }
    if (kind === 'sign-in') { fail('signed out: sign in again and copying goes on', limits.backoffMaxMs); say('on'); return 'backoff' }
    if (kind === 'cloud-full') { fail('her cloud is full', limits.backoffMaxMs); say('on'); return 'backoff' }
    if (kind === 'wait-until') {
      const retry = isRecord(answer) && uint(answer.retryAfterMs) ? Math.min(answer.retryAfterMs, limits.backoffMaxMs) : backoff
      fail('her cloud asked to wait', retry)
      say('on')
      return 'backoff'
    }
    // Silence, a 5xx, anything else: the cursor did not move, so the next try names the same `at` (ALREADY if it landed).
    const result = backOff(reply.status === 0 ? 'her cloud did not answer' : `her cloud answered ${String(reply.status)}`)
    say('on')
    return result
  }

  return {
    step,
    async run(sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })) {
      while (!isStopped()) {
        try { await step() } catch (error) { threadSyncState.lastError = error instanceof Error ? error.message : String(error) }
        if (isStopped()) break
        await sleep(Math.max(limits.tickMs, Math.min(waitUntil - now(), limits.backoffMaxMs)))
      }
    },
    async stop(reason = 'stopped') {
      stopped = reason
      await release().catch(() => {})
    },
    footer: () => lastFooter,
  }
}

/**
 * Start her writer after her tree is up, when everything in A3 holds and the mode read at boot was `on`. Returns null
 * (and tells the page, in mode `on`) when this page is not her writer. Never throws; never awaited by the boot.
 */
export async function startThreadWriter(options: ThreadWriterOptions & {
  readonly mode: ThreadSyncMode
  readonly locks?: ThreadWriterLocks | null
  readonly sleep?: (ms: number) => Promise<void>
}): Promise<{ writer: ThreadWriter; running: Promise<void> } | null> {
  if (options.mode !== 'on') return null
  const piece = options.piece ?? THREAD_PIECE
  const notWriter = (why: string): null => {
    threadSyncState.role = 'none'
    threadSyncState.lastError = why
    options.boot.publish('on', NONE_ON_FOOTER, 'none')
    return null
  }
  const eligible = writerEligible(options.persistence.hydration)
  if (!eligible.ok) return notWriter(eligible.why)
  // A3 (2): the newest thread her cloud holds that this browser holds too was last written by this browser.
  const cloud = new Map<string, CloudRow>()
  const limits: ThreadWriterLimits = { ...THREAD_WRITER_LIMITS, ...options.limits }
  let after = ''
  for (let page = 0; page < limits.indexPages; page += 1) {
    const reply = await options.net.get(`/_thread/index?limit=${String(limits.indexPageLimit)}${after === '' ? '' : `&after=${after}`}`, limits.requestMs, limits.indexBytes)
    const body = reply.status === 200 ? jsonOf(reply.bytes) : undefined
    if (!isRecord(body) || !Array.isArray(body.threads)) return notWriter('her thread index could not be read')
    if (body.sync !== 'on') return notWriter('copying to her cloud is not on at her edge')
    for (const row of body.threads as unknown[]) {
      if (!isRecord(row) || typeof row.id !== 'string' || !HEX64.test(row.id) || typeof row.path !== 'string') continue
      const activeAt = typeof row.activeAt === 'number' ? row.activeAt : typeof row.updatedAt === 'number' ? row.updatedAt : 0
      const parsed = cloudRowOf(row.id, row, piece, activeAt)
      if (parsed !== null) cloud.set(row.path, parsed)
    }
    if (typeof body.next !== 'string' || !HEX64.test(body.next)) break
    after = body.next
    if (page === limits.indexPages - 1) return notWriter('her thread index is longer than this page reads')
  }
  const mine = new Set(localThreadPaths(options.vfs))
  const shared = [...cloud.entries()].filter(([path]) => mine.has(path)).sort((a, b) => b[1].activeAt - a[1].activeAt)
  const newest = shared[0]
  if (newest !== undefined) {
    const reply = await options.net.get(`/_thread/manifest?id=${newest[1].id}&page=0`, limits.requestMs, limits.manifestBytes)
    const body = reply.status === 200 ? jsonOf(reply.bytes) : undefined
    const client = isRecord(body) && isRecord(body.thread) && isRecord(body.thread.run) ? body.thread.run.client : undefined
    if (client !== eligible.clientId) return notWriter('her newest conversation in her cloud was written by another browser')
  }
  // A3 (3): one tab of this browser at a time.
  const locks = options.locks === undefined
    ? (globalThis as { navigator?: { locks?: ThreadWriterLocks } }).navigator?.locks ?? null
    : options.locks
  if (locks === null || typeof locks.request !== 'function') return notWriter('this browser cannot hold the one-writer lock')
  const writer = createThreadWriter({ ...options, clientId: eligible.clientId, cloud })
  const lockState = { held: false }
  const running = (async () => {
    try {
      await locks.request(THREAD_WRITER_LOCK, { ifAvailable: true }, async (lock) => {
        if (lock === null || lock === undefined) return
        lockState.held = true
        threadSyncState.role = 'writer'
        await writer.run(options.sleep)
      })
    } catch (error) {
      threadSyncState.lastError = error instanceof Error ? error.message : String(error)
    }
    if (!lockState.held) {
      threadSyncState.role = 'none'
      threadSyncState.lastError = 'another tab of this browser is her writer'
      options.boot.publish('on', NONE_ON_FOOTER, 'none')
    }
  })()
  return { writer, running }
}
