/**
 * Thread sync decisions, as pure functions. Nothing imports this file yet; the wiring that
 * reads the file, calls the edge and shows the marks is a later job. Every function takes plain values and returns
 * plain values: no fetch, no IndexedDB, no timers, no clock read, no module state. Hashing uses WebCrypto only, so the
 * same code runs in a worker and in Node 20.
 *
 * A thread is an append-only JSONL file (`/dsh/home/sessions/<project>/<id>/session.v4.jsonl`). The edge keeps it as
 * sealed parts of `piece` bytes, each named by its SHA-256, plus an open end shorter than two pieces. Its manifest
 * carries the rolling `chain` over the part hashes and the `tailSha` of the open end; an append proves the browser's
 * copy up to its offset with `have` = `<chain>.<tailSha>`.
 *
 * The two promises every caller relies on (each one proven in thread-sync-plan.spec.ts):
 * 1. No step shortens or replaces local bytes, except a pull that follows a `keep-mine` whose `keep` call the edge
 *    acknowledged (200, also ALREADY): the bytes it replaces are first kept beside, in the vault.
 * 2. No pull adds bytes after local bytes that were not proven equal (by hashes) or compared equal (byte for byte, over
 *    the overlap the pull names). Otherwise a browser with unsent lines would get a spliced line, the session store's
 *    torn-line repair would cut it, and those lines would be lost without ever being kept beside.
 */

/** The edge's fixed protocol piece: part n covers bytes [n * PIECE, (n + 1) * PIECE). */
export const THREAD_PIECE = 2_097_152
/** The rolling chain before any part: 32 zero bytes. */
export const ZERO_CHAIN = '0'.repeat(64)
/** How long a file shorter than its own acknowledged lines may be mid roll-back before the cloud copy is retracted. */
export const ROLLBACK_SETTLE_MS = 2_000
/** The smallest slice `halve` returns. */
export const MIN_SLICE_BYTES = 65_536

const THREAD_PATH = /^\/dsh\/home\/(?:sessions\/[^/]+\/[^/]+\/session\.v\d+\.jsonl|[^/]+\/session\/messages\.jsonl)$/
const SHA_HEX = /^[0-9a-f]{64}$/
const NEWLINE = 0x0a

/** What the cloud holds of a thread after a request: every APPLIED or ALREADY answer carries it. */
export interface ThreadPair {
  bytes: number
  lineEnd: number
  sealedBytes: number
  chain: string
  tailSha: string
}

/** Which browser wrote the unbroken run of appends that ends the thread, and the offset where that run began. */
export interface ThreadRun {
  client: string
  from: number
}

/** The edge's manifest of one thread. */
export interface ThreadManifest extends ThreadPair {
  piece: number
  partCount: number
  parts: readonly string[]
  run: ThreadRun
  keptCount: number
}

/**
 * What `localFacts` compares against: a full manifest, or a reply's pair merged over the manifest the caller held. Only
 * part hashes for pieces below `sealedBytes` are used; a stale (shorter) `parts` list is read as far as it goes.
 */
export type ThreadCloudView = ThreadPair & { piece?: number; parts?: readonly string[] }

/** What hashes prove about this browser's copy of a thread against the cloud's. They claim no more than that. */
export interface LocalThreadFacts {
  /** This browser's length. */
  bytes: number
  /** Just after this browser's last newline (0 if none): nothing past it is ever sent. */
  lineEnd: number
  /** The first `cloud.bytes` local bytes give exactly the cloud's `chain` and `tailSha` at its `sealedBytes`. */
  extendsCloud: boolean
  /** Proven: `bytes <= cloud.bytes` and `provenBytes === bytes`. A shorter file ending inside a piece is NOT called a prefix. */
  cloudExtendsLocal: boolean
  /** The offset up to which the local file is PROVEN equal to the cloud's. */
  provenBytes: number
  /** Where a proven difference starts (a full sealed piece, or the open end), or null when none is proven. */
  forkAt: number | null
  /** The hashes of this file's full pieces, in order, for the caller to keep and pass back as `cachedParts`. */
  parts: readonly string[]
  /** Complete lines past `provenBytes`: what this browser holds that the cloud is not proven to hold. */
  linesAhead: number
}

/** How far this browser's own lines were acknowledged, and when that last settled. */
export interface ThreadCursor {
  acked: number
  settledAt: number
}

/** The one step `planThread` returns. */
export type ThreadStep =
  | { do: 'nothing' }
  | { do: 'append'; from: number; to: number }
  | { do: 'pull'; from: number; compareTo: number }
  | { do: 'card-only' }
  | { do: 'wait' }
  | { do: 'retract'; forkAt: number }
  | { do: 'keep-mine'; forkAt: number; then: 'pull' }
  | { do: 'reader' }

/** What the browser does with an answer from a thread route. No member means "stop for good". */
export type ThreadReplyKind =
  | 'done'
  | 'resend-from'
  | 'locate'
  | 'reader'
  | 'smaller'
  | 'again'
  | 'wait-until'
  | 'cloud-full'
  | 'reload'
  | 'sign-in'
  | 'held'

const subtle = (): SubtleCrypto => {
  const crypto = (globalThis as { crypto?: Crypto }).crypto
  if (crypto?.subtle === undefined) throw new Error('thread-sync-plan: WebCrypto (crypto.subtle) is required')
  return crypto.subtle
}

const toHex = (buffer: ArrayBuffer): string => {
  let out = ''
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, '0')
  return out
}
const fromHex = (hex: string): Uint8Array<ArrayBuffer> => {
  if (!SHA_HEX.test(hex)) throw new Error(`thread-sync-plan: not a SHA-256 hex digest: ${JSON.stringify(hex)}`)
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
const sha256 = async (bytes: Uint8Array): Promise<string> =>
  toHex(await subtle().digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))

const offset = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`thread-sync-plan: ${name} must be a non-negative integer`)
  return value
}
const pieceSize = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('thread-sync-plan: piece must be a positive integer')
  return value
}

/** Whether a path is a session journal the thread routes carry (the same rule as idb-persist's journal lane). */
export const threadPathAllowed = (path: string): boolean => THREAD_PATH.test(path)

/** The thread's id: SHA-256 hex of the path's UTF-8 bytes. */
export const threadIdFor = (path: string): Promise<string> => sha256(new TextEncoder().encode(path))

/** The hashes of the FULL pieces of `bytes`, in order. A last partial piece has none. */
export const partHashes = async (bytes: Uint8Array, pieceBytes: number): Promise<string[]> => {
  const piece = pieceSize(pieceBytes)
  const out: string[] = []
  for (let at = 0; at + piece <= bytes.byteLength; at += piece) out.push(await sha256(bytes.subarray(at, at + piece)))
  return out
}

/** Start with 32 zero bytes; for each part, chain = SHA-256(chain bytes followed by the part hash's 32 bytes). */
export const rollingChain = async (partShas: readonly string[]): Promise<string> => {
  let chain = fromHex(ZERO_CHAIN)
  for (const part of partShas) {
    const joined = new Uint8Array(64)
    joined.set(chain, 0)
    joined.set(fromHex(part), 32)
    chain = new Uint8Array(await subtle().digest('SHA-256', joined))
  }
  return toHex(chain.buffer)
}

/** SHA-256 of the bytes [sealedBytes, end) (of zero bytes when the range is empty). */
export const tailShaOf = (bytes: Uint8Array, sealedBytes: number, end: number): Promise<string> => {
  offset('sealedBytes', sealedBytes)
  offset('end', end)
  if (sealedBytes > end || end > bytes.byteLength) throw new Error('thread-sync-plan: tail range is outside the bytes')
  return sha256(bytes.subarray(sealedBytes, end))
}

/** The offset just after the last newline, 0 if there is none. */
export const lastLineEnd = (bytes: Uint8Array): number => bytes.lastIndexOf(NEWLINE) + 1

const countLines = (bytes: Uint8Array, from: number): number => {
  let lines = 0
  for (let at = bytes.indexOf(NEWLINE, from); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) lines++
  return lines
}

/**
 * What the local bytes prove against the cloud's. Each full local piece is hashed once (or taken from `cachedParts`)
 * and the cloud's open-end range once: no byte is hashed more than twice.
 * - `extendsCloud`: the first `cloud.bytes` local bytes give the cloud's `chain` and `tailSha`.
 * - `provenBytes`: `cloud.bytes` when `extendsCloud`; otherwise the end of the last full sealed piece both hold with every
 *   hash from 0 equal (0 when none). The equal-length case is `extendsCloud` itself (both its hashes must match).
 * - `cloudExtendsLocal`: `bytes <= cloud.bytes` and `provenBytes === bytes`, nothing weaker.
 * - `forkAt`: the start of the first full sealed piece whose hash differs; or `cloud.sealedBytes` when every sealed piece
 *   matches, the local file is at least as long as the cloud's and the open end differs; else null. A shorter file
 *   with no differing piece that does not end at `provenBytes` is UNPROVEN; only the pull's byte compare settles it.
 *   With a pair whose sealed part hashes are not all known, a chain that differs proves a fork but cannot place it:
 *   `forkAt` stays null, so pass the full manifest to locate a fork.
 * A null `cloud` is an empty cloud. `piece` comes from `cloud.piece`, else `options.piece`, else THREAD_PIECE.
 */
export const localFacts = async (
  bytes: Uint8Array,
  cloud: ThreadCloudView | null,
  options: { cachedParts?: readonly string[]; piece?: number } = {},
): Promise<LocalThreadFacts> => {
  const piece = pieceSize(cloud?.piece ?? options.piece ?? THREAD_PIECE)
  const length = bytes.byteLength
  const fullPieces = Math.floor(length / piece)
  const cached = (options.cachedParts ?? []).slice(0, fullPieces)
  for (const part of cached) fromHex(part)
  const parts = [...cached]
  for (let i = cached.length; i < fullPieces; i++) parts.push(await sha256(bytes.subarray(i * piece, (i + 1) * piece)))
  const lineEnd = lastLineEnd(bytes)
  const finish = (facts: Omit<LocalThreadFacts, 'bytes' | 'lineEnd' | 'parts' | 'linesAhead'>): LocalThreadFacts =>
    ({ bytes: length, lineEnd, parts, ...facts, linesAhead: countLines(bytes, facts.provenBytes) })
  if (cloud === null) {
    return finish({ extendsCloud: true, cloudExtendsLocal: length === 0, provenBytes: 0, forkAt: null })
  }

  const cloudBytes = offset('cloud.bytes', cloud.bytes)
  const sealed = offset('cloud.sealedBytes', cloud.sealedBytes)
  if (sealed % piece !== 0 || sealed > cloudBytes) throw new Error('thread-sync-plan: cloud.sealedBytes is not a whole number of pieces')
  const sealedCount = sealed / piece
  const known = Math.min(cloud.parts?.length ?? 0, sealedCount)
  const comparable = Math.min(known, fullPieces)
  let matched = 0
  while (matched < comparable && parts[matched] === cloud.parts?.[matched]) matched++
  const pieceFork = matched < comparable ? matched * piece : null
  if (pieceFork === null && matched === known && known < sealedCount && fullPieces >= sealedCount
    && await rollingChain(parts.slice(0, sealedCount)) === cloud.chain) matched = sealedCount
  const sealedMatch = matched === sealedCount

  const tailMatches = length >= cloudBytes && sealedMatch && await tailShaOf(bytes, sealed, cloudBytes) === cloud.tailSha
  if (tailMatches) {
    return finish({ extendsCloud: true, cloudExtendsLocal: length === cloudBytes, provenBytes: cloudBytes, forkAt: null })
  }
  const provenBytes = matched * piece
  const forkAt = pieceFork ?? (sealedMatch && length >= cloudBytes ? sealed : null)
  return finish({ extendsCloud: false, cloudExtendsLocal: length <= cloudBytes && provenBytes === length, provenBytes, forkAt })
}

/**
 * The caller's report of the pull's byte compare over [from, to). Only a report for exactly this file's unproven
 * overlap counts: `from === provenBytes`, `to === bytes`, no fork already known. Equal makes the whole file proven;
 * different is a fork at `from`. Any other report is stale and changes nothing.
 */
export const withOverlap = (
  local: LocalThreadFacts,
  report: { from: number; to: number; equal: boolean },
): LocalThreadFacts => {
  if (report.from !== local.provenBytes || report.to !== local.bytes || local.forkAt !== null) return local
  return report.equal
    ? { ...local, provenBytes: local.bytes, cloudExtendsLocal: true, linesAhead: 0 }
    : { ...local, forkAt: report.from, cloudExtendsLocal: false }
}

/** The next `have` (`<chain>.<tailSha>`) from an APPLIED or ALREADY body: the cloud's pair after that request. */
export const nextHave = (reply: Pick<ThreadPair, 'chain' | 'tailSha'>): string => {
  fromHex(reply.chain)
  fromHex(reply.tailSha)
  return `${reply.chain}.${reply.tailSha}`
}

/**
 * The one step for this thread now. See the module comment for the two promises; the rules:
 * - nothing: both absent; equal; local extends the cloud with no whole new line; or facts that decide nothing.
 * - append (writer only): from 0 (no cloud) or `cloud.bytes` (local extends it) to `local.lineEnd`, never past it.
 * - pull: local absent and `wanted` (from 0, compareTo 0); or local shorter, no fork, not this browser's own
 *   rolled-back lines: from `provenBytes`, compareTo `local.bytes`. The caller compares [from, compareTo) byte for byte,
 *   adds the cloud's bytes after compareTo only when all of it is equal (and the file is still compareTo long), and
 *   reports a difference with `withOverlap(.., equal: false)`, then plans again.
 * - card-only: local absent and not `wanted`.
 * - wait: local shorter than `cursor.acked`, the cloud's extra lines are this browser's own run ending at `acked`, and
 *   less than ROLLBACK_SETTLE_MS since `settledAt`: the session store may be mid roll-back.
 * - retract (writer only): that case after the wait (at `local.lineEnd`: the cloud lines past it are this browser's own
 *   rolled-back run; the edge keeps what it displaces beside), or a fork inside this browser's own newest run. Either way
 *   only at or past the sealed parts and the run's start; otherwise the rolled-back case pulls.
 * - keep-mine then pull (writer): every other fork. The pull may replace bytes only after the `keep` is acknowledged.
 * - reader: not the writer and local has lines the cloud lacks; they stay here, marked.
 */
export const planThread = ({ local, cloud, cursor, me, isWriter, wanted, now }: {
  local: LocalThreadFacts | null
  cloud: ThreadManifest | null
  cursor: ThreadCursor | null
  me: string
  isWriter: boolean
  wanted: boolean
  now: number
}): ThreadStep => {
  if (local === null) {
    if (cloud === null) return { do: 'nothing' }
    return wanted ? { do: 'pull', from: 0, compareTo: 0 } : { do: 'card-only' }
  }
  if (cloud === null) {
    if (local.lineEnd === 0) return { do: 'nothing' }
    return isWriter ? { do: 'append', from: 0, to: local.lineEnd } : { do: 'reader' }
  }
  if (local.extendsCloud) {
    if (local.lineEnd <= cloud.bytes) return { do: 'nothing' }
    return isWriter ? { do: 'append', from: cloud.bytes, to: local.lineEnd } : { do: 'reader' }
  }
  const ownRun = cloud.run.client === me
  if (local.forkAt !== null) {
    if (!isWriter) return { do: 'reader' }
    if (ownRun && local.forkAt >= cloud.sealedBytes && local.forkAt >= cloud.run.from) return { do: 'retract', forkAt: local.forkAt }
    return { do: 'keep-mine', forkAt: local.forkAt, then: 'pull' }
  }
  if (local.bytes >= cloud.bytes) return { do: 'nothing' }
  const pull: ThreadStep = { do: 'pull', from: local.provenBytes, compareTo: local.bytes }
  const rolledBack = cursor !== null && ownRun && local.bytes < cursor.acked && cloud.bytes === cursor.acked
  if (!rolledBack) return pull
  if (now - cursor.settledAt < ROLLBACK_SETTLE_MS) return { do: 'wait' }
  const at = local.lineEnd
  if (isWriter && at >= cloud.sealedBytes && at >= cloud.run.from) return { do: 'retract', forkAt: at }
  return pull
}

/**
 * Whether her next line may be written. True ONLY for the writer whose file extends the cloud's to at least its
 * length (or with no cloud copy). A writer behind the cloud first pulls to equality and re-opens the session from the
 * file; otherwise the line just typed would fork from another browser's lines and be put aside.
 */
export const mayStartTurn = ({ local, cloud, isWriter }: {
  local: LocalThreadFacts | null
  cloud: ThreadPair | null
  isWriter: boolean
}): boolean => {
  if (!isWriter) return false
  if (cloud === null) return true
  return local !== null && local.extendsCloud && local.bytes >= cloud.bytes
}

/** Consecutive slices [from, to) of at most `pieceBytes`, the last ending at `to`. */
export const partsForAppend = (from: number, to: number, pieceBytes: number): Array<{ from: number; to: number }> => {
  offset('from', from)
  offset('to', to)
  const piece = pieceSize(pieceBytes)
  if (from > to) throw new Error('thread-sync-plan: an append cannot end before it starts')
  const out: Array<{ from: number; to: number }> = []
  for (let at = from; at < to; at += piece) out.push({ from: at, to: Math.min(to, at + piece) })
  return out
}

/** Half a slice size after a 413, never under MIN_SLICE_BYTES. */
export const halve = (size: number): number => Math.max(MIN_SLICE_BYTES, Math.floor(size / 2))

/**
 * What an answer from a thread route means. Every member keeps the lines in this browser and can resume; none is a
 * stop for good. `held` (400, 403, 404, 422, 424) is a refusal that will not change by itself: the thread is named in
 * the lane and "Send now" tries again, never a timer. Pass status 0 for a network error.
 */
export const classifyThreadReply = (status: number, code?: string | null): ThreadReplyKind => {
  switch (status) {
    case 200: return code === 'APPLIED' || code === 'ALREADY' ? 'done' : 'again'
    case 409: return code === 'GAP' ? 'resend-from' : code === 'DIVERGED' ? 'locate' : 'again'
    case 410:
    case 423: return 'reader'
    case 413: return 'smaller'
    case 429: return 'wait-until'
    case 507: return 'cloud-full'
    case 426: return 'reload'
    case 401: return 'sign-in'
    case 400:
    case 403:
    case 404:
    case 422:
    case 424: return 'held'
    default: return 'again'
  }
}

/** The last answer a thread route gave, and when it arrived. */
export interface ThreadLastReply {
  kind: ThreadReplyKind
  code?: string | null
  at: number
}

/** A lane mark: its text, its one action, and how the footer counts it. */
export interface ThreadLaneMark {
  text: string
  action?: 'Send now' | 'Show'
  /** `cloud`: proven in the cloud; `browser`: holds lines only this browser has; `other`: neither is claimed. */
  counts: 'cloud' | 'browser' | 'other'
}

const clock = (ms: number): string => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
const megabytes = (bytes: number, round: (value: number) => number): number => round(bytes / 1_000_000)

const onlyHere = (detail: string): ThreadLaneMark => ({ text: `Only in this browser · ${detail}`, action: 'Send now', counts: 'browser' })

/**
 * The mark beside one thread in the lane, or null for a thread that exists nowhere. A thread is "In the cloud" ONLY
 * when local extends the cloud and `cloud.lineEnd >= local.lineEnd` (or it has no local copy at all), never from the
 * absence of another mark. The time beside it is the last acknowledged answer, else `now` (when it was checked).
 */
export const laneMark = ({ local, cloud, lastReply, retryAt, isWriter, loading, now }: {
  local: LocalThreadFacts | null
  cloud: ThreadManifest | null
  lastReply: ThreadLastReply | null
  retryAt: number | null
  isWriter: boolean
  loading: { received: number; total: number } | null
  now: number
}): ThreadLaneMark | null => {
  if (loading !== null) {
    const text = `Loading this thread: ${megabytes(loading.received, Math.floor)} of ${megabytes(loading.total, Math.round)} MB`
    return { text, counts: 'other' }
  }
  if (lastReply?.code === 'HOME_PENDING') return { text: 'This browser is not saving to her cloud', counts: 'other' }
  if (local === null) return cloud === null ? null : { text: 'In the cloud · not on this device yet', counts: 'cloud' }
  const inCloud = cloud !== null && local.extendsCloud && cloud.lineEnd >= local.lineEnd
  if (inCloud) {
    if (cloud.keptCount > 0) return { text: `${plural(cloud.keptCount, 'message', 'messages')} kept beside`, action: 'Show', counts: 'cloud' }
    return { text: `In the cloud · ${clock(lastReply?.kind === 'done' ? lastReply.at : now)}`, counts: 'cloud' }
  }
  const behind = cloud !== null && local.forkAt === null && !local.extendsCloud && local.bytes < cloud.bytes
  if (behind) return { text: 'In the cloud · not on this device yet', counts: 'other' }
  if (!isWriter || lastReply?.kind === 'reader') return { text: 'Answering in another browser', counts: 'browser' }
  switch (lastReply?.kind) {
    case 'again': return onlyHere('offline')
    case 'sign-in': return onlyHere('sign in again')
    case 'wait-until': return retryAt === null ? onlyHere('offline') : onlyHere(`until ${clock(retryAt)}`)
    case 'cloud-full': return onlyHere('cloud is full')
    case 'held':
    case 'reload': return onlyHere('held')
    default: return { text: `Saving · ${plural(local.linesAhead, 'line', 'lines')} to go`, counts: 'browser' }
  }
}

/** The lane's footer: "17 threads · 16 in the cloud · 1 only in this browser". */
export const laneFooter = (marks: ReadonlyArray<ThreadLaneMark | null>): string => {
  const present = marks.filter((mark): mark is ThreadLaneMark => mark !== null)
  const cloud = present.filter(mark => mark.counts === 'cloud').length
  const browser = present.filter(mark => mark.counts === 'browser').length
  return `${plural(present.length, 'thread', 'threads')} · ${cloud} in the cloud · ${browser} only in this browser`
}
