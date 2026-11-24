/**
 * Thread sync, the writer half: her ONE writer browser copies each thread's new lines to her cloud as they are
 * written, so "Copy to her cloud" and "Join her threads" on `/rescue` stop being the daily path (they stay, as the
 * fallback). Started by worker-host.ts after her tree is up; it never runs while the mode is not `on`.
 *
 * Who writes (built here on attach's hydration facts, with no new IndexedDB call):
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
import { localFactsFromHydration, NONE_ON_FOOTER, threadMetaHeader, threadSyncState, type ThreadSyncBoot } from './thread-sync.ts'
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

/**
 * CARD 1.5: what her cloud last told THIS page it holds of ONE conversation, and on whose word. `basis` carries the whole
 * honesty of it: `applied`/`already` are her cloud's own answer about a span this browser sent (an append is accepted
 * only against the chain and tail her cloud holds, so those bytes are a prefix her cloud confirmed); `index` is only what
 * her index listed when this page read it, which nothing here has checked against this browser's own bytes. A sentence
 * must never render the second as the first.
 */
export interface ThreadAckReceipt {
  readonly id: string
  /** The end offset of the span THIS browser sent, and her cloud's own byte count in the same answer. Two numbers: `cloud`
   * is >= `bytes` when another holder appended past the span, so a sentence can state the first as ours and the second as
   * hers without borrowing one for the other. */
  readonly bytes: number
  readonly cloud: number
  readonly lineEnd: number
  readonly tailSha: string
  readonly basis: 'index' | 'applied' | 'already'
  readonly at: number
}

/** A conversation's name for a sentence: its folder for a session journal, else the file, printable and 24 chars at most. */
export function threadLabel(path: string): string {
  const parts = path.split('/').filter(part => part !== '')
  const last = parts[parts.length - 1] ?? 'conversation'
  const before = (back: number): string => parts[parts.length - back] ?? last
  const raw = last === 'session.v4.jsonl' ? before(2) : last === 'messages.jsonl' && before(2) === 'session' ? before(3) : last
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim()
  return (clean === '' ? 'conversation' : clean).slice(0, 24)
}

/** The eight hex characters of her cloud's own tail that two browsers can compare. */
const tail8 = (sha: string): string => sha.slice(0, 8)

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
  /**
   * HER SENDER (Card 1): the live sender, off unless `worker-host.ts` asks for it by name. Off, every default and every
   * sentence in this module answers exactly as main does, which is why the existing spec is untouched by this card.
   */
  readonly live?: boolean
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
export function writerEligible(
  hydration: HydrationFacts | null | undefined,
  /**
   * HER SENDER (Card 1): when true, the whole-file mirror's fence and the stored mirror `seq` are not asked. The caller
   * (`startThreadWriter` with `live: true`, from `worker-host.ts`) is the only one that passes it; every other caller,
   * the existing spec included, gets main's answers unchanged.
   */
  live = false,
): { ok: true; clientId: string } | { ok: false; why: string } {
  if (localFactsFromHydration(hydration) !== 'saved-before' || !hydration) return { ok: false, why: 'this browser has not saved her before' }
  if (!live) {
    if (hydration.cloud !== 'confirmed') return { ok: false, why: `her cloud did not confirm this browser's last save at this boot (${hydration.cloud})` }
    if (hydration.seq === null || hydration.seq <= 0) return { ok: false, why: 'this browser has no acknowledged save of its own' }
    if (hydration.clientId === null || hydration.clientId === '') return { ok: false, why: 'this browser has no mirror client id' }
    return { ok: true, clientId: hydration.clientId }
  }
  // HER SENDER 1: the mirror fence is not the log's guard. An append is accepted only at the exact end her cloud already
  // holds, against the chain and tail it holds and the body's SHA-256, under a live lease; a browser out of step with the
  // whole-file mirror therefore cannot corrupt one line of the thread log. It is exactly the browser whose new lines
  // nobody else has. The client id still names the lease holder, so it is asked for — and minted for this page load when
  // the store has none (a store restored from a rescue, a browser that never finished a mirror save).
  const stored = hydration.clientId
  return { ok: true, clientId: typeof stored === 'string' && stored !== '' ? stored : mintTabId() }
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
  let lastFooterKey: string | null = null
  let footerKind: 'ok' | 'paused' | 'refused' | 'silent' | 'store' | 'wait' = 'ok'
  let holderLabel: string | null = null
  /** HER SENDER (Card 1): the live path only. Off, nothing below changes what main sends or says. */
  const live = options.live === true
  /** What her cloud's index said at this load, so a reload with nothing new can answer from it instead of from silence. */
  const indexFacts = { at: now(), threads: cloud.size, bytes: [...cloud.values()].reduce((sum, row) => sum + row.bytes, 0) }
  /**
   * CARD 1.5: ONE receipt per conversation, in memory only, rebuilt at boot from the index this page already read
   * (`basis: 'index'`) and moved forward only by her cloud's own APPLIED/ALREADY answer. Nothing is stored here, so
   * there is no second copy of her cloud's state to drift out of step with it: a reload starts again from the index.
   */
  const receipts = new Map<string, ThreadAckReceipt>()
  /** The same conversations' byte counts at boot, so `bytes` counts only what THIS page load did. */
  const bootBytes = new Map<string, number>()
  /** The end offset of the furthest span her cloud answered this load: idempotent, so a replay cannot raise it twice. */
  const ownHigh = new Map<string, number>()
  if (live) {
    for (const [path, row] of cloud) {
      receipts.set(path, { id: row.id, bytes: row.bytes, cloud: row.bytes, lineEnd: row.lineEnd, tailSha: row.tailSha, basis: 'index', at: indexFacts.at })
      bootBytes.set(path, row.bytes)
    }
  }
  /** When her cloud asked this browser to wait (a 429 with a retry time), so the lane can say until when. */
  let waitUntilAt: number | null = null

  /** CARD 1.5: the bytes her cloud confirmed from this browser this page load, once per span however often it is replayed. */
  const bytesThisLoad = (): number => {
    let sum = 0
    for (const [path, high] of ownHigh) sum += Math.max(0, high - (bootBytes.get(path) ?? 0))
    return sum
  }

  /** One conversation as this page can honestly describe it: what the file holds, and what her cloud's word covers. */
  interface Surveyed {
    readonly path: string
    readonly size: number
    readonly held: number
    readonly listed: number
    readonly unsent: number
    readonly moving: boolean
    readonly diverged: boolean
    readonly receipt: ThreadAckReceipt | null
  }

  /**
   * CARD 1.5: look at every conversation this browser holds, from `stat` and the receipts alone. Deliberately not the
   * planner's count: `planFor` stops at the first conversation it can send, so a lane fed by it said nothing was pending
   * for conversations it had not looked at — and said 0 while a hot one never left the settle window. File sizes and
   * receipts are cheap and always current, and this pass runs whatever the planner is doing. A file whose size cannot be
   * read is counted as UNMEASURED and never as caught up.
   */
  const survey = (): { rows: Surveyed[]; pendingBytes: number; worst: Surveyed | null; unmeasured: number } => {
    const rows: Surveyed[] = []
    let paths: string[] = []
    let unmeasured = 0
    try { paths = localThreadPaths(vfs) } catch { paths = [] }
    const at = now()
    for (const path of paths) {
      let size = 0
      try {
        const stat = vfs.statSync(path)
        if (!stat.isFile()) { unmeasured += 1; continue }
        size = Number(stat.size)
      } catch { unmeasured += 1; continue }
      const receipt = receipts.get(path) ?? null
      const listed = cloud.get(path)?.bytes ?? 0
      const held = Math.max(receipt === null ? 0 : receipt.bytes, receipt === null ? 0 : receipt.cloud, listed)
      const track = local.get(path) ?? null
      const moving = track !== null && at - track.changedAt < ROLLBACK_SETTLE_MS
      // A file shorter than her cloud's word is diverged only once it has STOPPED moving: mid-rewrite a truncation is a
      // write in progress, not a disagreement, and this page must not call it one.
      rows.push({ path, size, held, listed, unsent: Math.max(0, size - held), receipt, moving, diverged: !moving && size < held })
    }
    const pendingBytes = rows.reduce((sum, row) => sum + row.unsent, 0)
    // The conversation a sentence names is the one that needs saying, not whichever was appended last.
    const rank = (row: Surveyed): number => (row.diverged ? 3 : row.unsent > 0 && row.moving ? 2 : row.unsent > 0 ? 1 : 0)
    const worst = rows.filter(row => rank(row) > 0).sort((a, b) => rank(b) - rank(a) || b.unsent - a.unsent)[0] ?? null
    return { rows, pendingBytes, worst, unmeasured }
  }

  /** What her cloud's word about one conversation actually is: its own answer, or only what its index listed. */
  const basisOf = (row: Surveyed): string => {
    const receipt = row.receipt
    if (receipt !== null && receipt.basis !== 'index') return `her cloud confirmed ${String(receipt.bytes)} bytes at ${clock(receipt.at)}`
    if (row.listed > 0) return `her cloud's index listed ${String(row.listed)} bytes at ${clock(indexFacts.at)}`
    if (receipt !== null) return `her cloud's index listed ${String(receipt.bytes)} bytes at ${clock(receipt.at)}`
    return 'her cloud had no entry for it'
  }

  /**
   * CARD 1.5: the live lane's sentence. Every number in it is a measurement (a file size, an offset her cloud answered
   * about, an index row at a time), the conversation it speaks about is named, and the bare word "saved" appears nowhere:
   * an acknowledged byte is transport progress, never a turn that cannot be lost. Each sentence stays under 200 characters
   * even with a 24-character name and a nine-digit count, so nothing is cut mid-claim.
   */
  const liveFooter = (seen: { rows: Surveyed[]; pendingBytes: number; worst: Surveyed | null; unmeasured: number }): string => {
    const worst = seen.worst
    if (worst !== null && worst.diverged) {
      const said = worst.receipt === null || worst.receipt.basis === 'index' ? 'listed' : 'confirmed'
      return `Her cloud ${said} ${String(worst.held)} bytes of ${threadLabel(worst.path)}; this browser has ${String(worst.size)}. Nothing more of it is being copied.`
    }
    if (worst !== null) {
      const name = threadLabel(worst.path)
      if (worst.moving) {
        return `${name} is still changing: ${String(worst.unsent)} bytes of it are not in her cloud yet. Copying starts once it has gone ${String(Math.round(ROLLBACK_SETTLE_MS / 1_000))} s without changing.`
      }
      const others = seen.rows.filter(row => row.path !== worst.path && row.unsent > 0).length
      const rest = others === 0 ? '' : ` ${String(others)} other conversation${others === 1 ? '' : 's'} also wait${others === 1 ? 's' : ''}.`
      return `${String(worst.unsent)} bytes of ${name} are not in her cloud yet; ${basisOf(worst)}.${rest}`
    }
    if (seen.unmeasured > 0) {
      return `This browser could not measure ${String(seen.unmeasured)} of its conversations, so nothing here counts what is in her cloud.`
    }
    const confirmed = [...receipts.entries()].filter(([, receipt]) => receipt.basis !== 'index').sort((a, b) => b[1].at - a[1].at)[0] ?? null
    if (confirmed !== null) {
      const [path, receipt] = confirmed
      const tail = receipt.cloud === receipt.bytes ? ` (tail ${tail8(receipt.tailSha)})` : ''
      return `At ${clock(receipt.at)} her cloud confirmed the first ${String(receipt.bytes)} bytes of ${threadLabel(path)}${tail}. Nothing is queued in this browser.`
    }
    const largest = [...receipts.entries()].sort((a, b) => b[1].bytes - a[1].bytes)[0] ?? null
    const named = largest === null ? '' : ` Largest: ${threadLabel(largest[0])} (${String(largest[1].bytes)} bytes listed, tail ${tail8(largest[1].tailSha)}).`
    return `Nothing new to send. Her cloud's index held ${String(indexFacts.bytes)} bytes of ${String(indexFacts.threads)} ${indexFacts.threads === 1 ? 'conversation' : 'conversations'} at ${clock(indexFacts.at)}.${named}`
  }

  const say = (mode: ThreadSyncMode): void => {
    const pendingLines = [...local.values()].reduce((sum, track) => sum + track.pendingLines, 0)
    const rolledBack = [...local.values()].filter(track => track.held !== null && track.held.startsWith('rolled back')).length
    threadSyncState.pending = pendingLines
    const seen = live ? survey() : null
    if (seen !== null) {
      threadSyncState.pendingBytes = seen.pendingBytes
      threadSyncState.bytes = bytesThisLoad()
    }
    const last = threadSyncState.lastOkAtMs
    let footer: string
    if (footerKind === 'wait') footer = `Her cloud asked to wait${waitUntilAt === null ? '' : ` until ${clock(waitUntilAt)}`}. New lines stay in this browser and go then.`
    else if (footerKind === 'paused') footer = 'Copying to her cloud is paused. New lines stay in this browser.'
    else if (footerKind === 'refused') footer = `She is answering in ${holderLabel ?? 'another browser'}. This browser's new lines stay here.`
    else if (footerKind === 'silent') footer = 'Her cloud did not answer. New lines stay in this browser and are sent when it does.'
    else if (footerKind === 'store') footer = 'Copying to her cloud is paused. New lines stay in this browser.'
    else if (rolledBack > 0) footer = rolledBack === 1 ? '1 conversation stopped copying and needs your card.' : `${String(rolledBack)} conversations stopped copying and need your card.`
    else if (live && seen !== null) footer = liveFooter(seen)
    else if (pendingLines > 0) footer = `Only in this browser: ${String(pendingLines)} ${pendingLines === 1 ? 'line' : 'lines'}.${last === null ? '' : ` Last in her cloud ${clock(last)}.`}`
    else footer = `In her cloud ${clock(last ?? now())}.`
    // Dedup on what was acknowledged as well as on the sentence, so a second ack in the same minute still shows.
    const key = `${footer}|${String(threadSyncState.bytes)}|${String(threadSyncState.pendingBytes)}|${footerKind}`
    if (key === lastFooterKey) return
    lastFooterKey = key
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
    // A3 (4): never while this browser's own store is read-only, or (always) in a local multi-tab conflict. HER SENDER:
    // `persistence.conflict` is LOCAL IndexedDB split-brain, not the cloud mirror's fence, so
    // it keeps its power even live — and a conflicted tab now lets the lease go and stops, so the live tab can hold it.
    if (persistence.readOnly || (persistence.conflict ?? null) !== null || (!live && (persistence.localSave?.error ?? null) !== null)) {
      if (live && (persistence.conflict ?? null) !== null) {
        stopped = 'this store is in a conflict with another tab of this browser'
        fail('another tab of this browser holds this store (a conflict); this tab stops copying and lets the turn go', limits.backoffMaxMs, 'store')
        await release()
        say('on')
        return 'stopped'
      }
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
    // One append per step. Live, the conversation with the LEAST unsent bytes goes first, so a new 1 KB turn is never
    // queued behind the remaining 2 MiB pieces of a 100 MB or 180 MB first upload (sorting by path did exactly
    // that once piece 1 of a cold thread landed and made it look like a live one). Off, main's sorted order is unchanged.
    let ordered: string[] = []
    try { ordered = localThreadPaths(vfs) } catch { ordered = [] }
    if (live) {
      const unsent = (path: string): number => {
        try {
          const row = cloud.get(path)
          return Number(vfs.statSync(path).size) - (row === undefined ? 0 : row.bytes)
        } catch { return Number.MAX_SAFE_INTEGER }
      }
      ordered = [...ordered].sort((a, b) => unsent(a) - unsent(b))
    }
    for (const path of ordered) {
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
      ...threadMetaHeader(body, Date.now()),
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
      if (live) {
        // CARD 1.5: her cloud's own answer, attached to the conversation it is about. The end offset is the span THIS
        // browser sent (`to`), not `row.bytes` — that one scalar, overwritten by whichever conversation was appended last,
        // is what let a sentence speak for the wrong conversation. `ownHigh` makes the byte count idempotent, so a span
        // answered ALREADY after a replay cannot count twice.
        receipts.set(chosenPath, { id, bytes: to, cloud: row.bytes, lineEnd: row.lineEnd, tailSha: row.tailSha,
          basis: code === 'APPLIED' ? 'applied' : 'already', at: now() })
        ownHigh.set(chosenPath, Math.max(ownHigh.get(chosenPath) ?? 0, to))
      }
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
      const asked = isRecord(answer) && uint(answer.retryAfterMs) ? answer.retryAfterMs : null
      const retry = asked === null ? backoff : Math.min(asked, limits.backoffMaxMs)
      // HER SENDER: a 429 that says when to come back is not silence, and "her cloud did not answer" would be a lie.
      if (live) {
        waitUntilAt = asked === null ? null : now() + asked
        fail('her cloud asked to wait', retry, 'wait')
      } else {
        fail('her cloud asked to wait', retry)
      }
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
  const eligible = writerEligible(options.persistence.hydration, options.live === true)
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
