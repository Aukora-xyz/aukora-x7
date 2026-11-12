// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * WHAT THE WORK VIEW READS FOR AUTONOMY (Round 12): her memory DAG and surprise corpus (recall), and the host's wake
 * timer (`/_host/wake`).
 *
 *   RECALL. Her `seed-memory` DAG is content addressed: a node file `<id>.json` holds the node with its own `id`, and
 *     `id === sha256(canonicalJson(node without id))` (her organ's `dagNodeId`). Two node shapes share that rule: her
 *     organ's (`parentIds`) and `auma.memory.dag.node.v1` (`parents`). This tab walks from HEAD.json through the parent
 *     links and recomputes every id it reads, so "verified" here means the bytes it read, when it read them, hash to
 *     their names. The surface walks again whenever HEAD names a different tip.  A node it could not read is `unread`
 *     (said as such), never `broken`. The surprise corpus is her own export:
 *     its scores are her words, counted and labelled as such. When the page readout carries the recall projector
 *     (`snapshot.recall`), the surface shows that instead.
 *   WAKE. GET `/_host/wake` is the timer's state; POST `{ action: 'trigger' }` asks for one wake now and
 *     `{ action: 'configure', enabled, intervalMs }` turns the timer on or off. The interval is bounded by the host
 *     (60 s to 24 h); this client never sends one outside that. An unserved route (404 or the app page) is `absent`.
 *
 *   COUNT. HEAD.json says how many nodes the DAG holds. When every node reachable from its heads verifies but the
 *     reachable count differs from that number, the DAG is `forked`: nodes exist (or are counted) that the walk cannot
 *     reach. Said as "N of M reachable", never as verified.
 *   CORPUS STATUS. Each trajectory row is either marked `UNAUTHENTICATED_PRE_EPOCH_54`, or names its register and
 *     observe receipt hashes (a receipt-anchored CLAIM: this tab does not look those receipts up), or neither.
 *   LIVE (Round 13). One page-wide listener: `BroadcastChannel('aukora-x6-balls')` (her worker's ball commits, this
 *     tab and others: ONLY ball commits are taken from it) and the host's `/_head/ws` (`ball:commit`,
 *     `mirror:updated`, `wake:updated`, `runtime:updated`, `head:staged`: host facts are taken only from the socket). It opens while
 *     any surface listens and closes a second after none does (a surface switch keeps it); it never announces
 *     presence or sends anything. The head snapshot the host sends on the first connect is not a new commit and is
 *     dropped; a ball frame (which carries all module code) is recognised from its first bytes, never parsed whole.
 *
 * @module work/autonomy
 */
import { useEffect, useRef, useState } from 'react'

/** Her memory DAG, as she writes it. */
export const MEMORY_DAG_DIR = '/dsh/home/auma/memory/dag'
/** Her discovery-trajectory export (`seed-predict.js` `exportDiscoveryCorpus`). */
export const DISCOVERY_CORPUS_PATH = '/dsh/home/auma/seed/discovery-corpus.v1.jsonl'
/** The host's wake timer route. */
export const WAKE_ROUTE = '/_host/wake'
/** The host's interval bounds for the wake timer. */
export const WAKE_MIN_MS = 60_000
export const WAKE_MAX_MS = 86_400_000
/** The interval this view asks for when the host reports none in bounds. */
export const WAKE_DEFAULT_MS = 3_600_000
/** At most this many DAG nodes are read and checked per walk. */
export const MAX_DAG_NODES = 512

const ID = /^[0-9a-f]{64}$/
type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Her organ's canonical JSON: sorted keys, undefined dropped, no whitespace. Throws on a non-finite number. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('INVALID_NUMBER')
    const text = JSON.stringify(value) as string | undefined
    if (text === undefined) throw new Error('INVALID_JSON_VALUE')
    return text
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Json
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw new Error('SHA-256 is not available in this page')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** The id a node's bytes name: sha256 of the canonical node without its `id`. */
export async function dagNodeId(node: Json): Promise<string> {
  const copy: Json = { ...node }
  delete copy.id
  return sha256Hex(canonicalJson(copy))
}

/** One file read for the walk. */
export type DagFileRead = { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'missing' } | { readonly kind: 'unreadable'; readonly detail: string }

/** What the walk found. */
export type DagCheck =
  | { readonly kind: 'verified'; readonly nodes: number; readonly tip: string | null }
  | { readonly kind: 'bounded'; readonly nodes: number; readonly tip: string | null }
  | { readonly kind: 'forked'; readonly nodes: number; readonly expected: number; readonly tip: string | null }
  | { readonly kind: 'broken'; readonly nodes: number; readonly at: string; readonly reason: 'missing' | 'malformed' | 'hash-mismatch' }
  | { readonly kind: 'unread'; readonly nodes: number; readonly at: string; readonly detail: string }

/** A node's parent links: her organ's `parentIds`, or `parents` in `auma.memory.dag.node.v1`; null when neither. */
function parentLinks(node: Json): readonly unknown[] | null {
  if (Array.isArray(node.parentIds)) return node.parentIds
  if (node.parentIds === undefined && Array.isArray(node.parents)) return node.parents
  return null
}

/** Verified ids and their parents within one walk. */
export type DagCache = Map<string, readonly string[]>

/**
 * Walk her DAG from `heads` through `parentIds`, recomputing each node's id.
 * @param heads - HEAD.json `heads` (or `headId`).
 * @param read - reads one node file by id.
 * @param cache - verified ids from earlier walks; only new ids are read.
 * @param limit - at most this many nodes are checked.
 * @param expectedCount - HEAD.json's node count, or null when it gives none.
 */
export async function verifyDag(
  heads: readonly string[], read: (id: string) => Promise<DagFileRead>, cache: DagCache, limit: number = MAX_DAG_NODES,
  expectedCount: number | null = null,
): Promise<DagCheck> {
  if (globalThis.crypto?.subtle === undefined) throw new Error('SHA-256 is not available in this page')
  const tip = heads[0] ?? null
  const seen = new Set<string>()
  const stack = [...heads]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    if (seen.size >= limit) return { kind: 'bounded', nodes: seen.size, tip }
    if (!ID.test(id)) return { kind: 'broken', nodes: seen.size, at: id, reason: 'malformed' }
    let parents = cache.get(id)
    if (parents === undefined) {
      const file = await read(id)
      if (file.kind === 'unreadable') return { kind: 'unread', nodes: seen.size, at: id, detail: file.detail }
      if (file.kind === 'missing') return { kind: 'broken', nodes: seen.size, at: id, reason: 'missing' }
      let node: unknown
      try { node = JSON.parse(file.text) } catch { return { kind: 'broken', nodes: seen.size, at: id, reason: 'malformed' } }
      const links = isJson(node) ? parentLinks(node) : null
      if (!isJson(node) || links === null || (node.id !== undefined && node.id !== id)) {
        return { kind: 'broken', nodes: seen.size, at: id, reason: 'malformed' }
      }
      let computed: string
      try { computed = await dagNodeId(node) } catch { return { kind: 'broken', nodes: seen.size, at: id, reason: 'malformed' } }
      if (computed !== id) return { kind: 'broken', nodes: seen.size, at: id, reason: 'hash-mismatch' }
      parents = links.filter((p): p is string => typeof p === 'string')
      if (parents.length !== links.length) return { kind: 'broken', nodes: seen.size, at: id, reason: 'malformed' }
      cache.set(id, parents)
    }
    seen.add(id)
    for (const parent of parents) if (!seen.has(parent)) stack.push(parent)
  }
  if (expectedCount !== null && seen.size !== expectedCount) return { kind: 'forked', nodes: seen.size, expected: expectedCount, tip }
  return { kind: 'verified', nodes: seen.size, tip }
}

/** Her corpus file, counted. Scores are her own words; nothing here re-checks them against receipts. */
export interface CorpusCount {
  readonly trajectories: number
  /** Trajectories whose `surpriseScore` is a finite number above 0: the lessons recall puts first. */
  readonly highSurprise: number
  /** Lines that were not a JSON object. */
  readonly unreadableLines: number
  /** Rows marked `UNAUTHENTICATED_PRE_EPOCH_54`. */
  readonly unauthenticated: number
  /** Rows naming a 64-hex register AND observe receipt hash (a claim; not looked up here). */
  readonly anchoredClaims: number
  /** Rows carrying neither: treated as unauthenticated. */
  readonly unmarked: number
}

/** The marker her pre-epoch-54 rows carry. */
export const PRE_EPOCH_54 = 'UNAUTHENTICATED_PRE_EPOCH_54'

/** What the corpus rows say about their own authentication, as a whole. */
export type CorpusStatus = 'unauthenticated' | 'anchored-claim' | 'mixed' | 'unmarked' | 'empty'

/** The corpus's overall status: every row unauthenticated, every row anchored (claimed), a mix, or unmarked. */
export function corpusStatus(count: CorpusCount): CorpusStatus {
  if (count.trajectories === 0) return 'empty'
  if (count.unauthenticated === count.trajectories) return 'unauthenticated'
  if (count.anchoredClaims === count.trajectories) return 'anchored-claim'
  if (count.unauthenticated + count.anchoredClaims === 0) return 'unmarked'
  return 'mixed'
}

/** Count her `discovery-corpus.v1.jsonl`. */
export function countCorpus(text: string): CorpusCount {
  let trajectories = 0
  let highSurprise = 0
  let unreadableLines = 0
  let unauthenticated = 0
  let anchoredClaims = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try { row = JSON.parse(line) } catch { unreadableLines += 1; continue }
    if (!isJson(row)) { unreadableLines += 1; continue }
    trajectories += 1
    const score = row.surpriseScore
    if (typeof score === 'number' && Number.isFinite(score) && score > 0) highSurprise += 1
    if (row.verificationStatus === PRE_EPOCH_54) unauthenticated += 1
    else if (typeof row.registerReceiptHash === 'string' && ID.test(row.registerReceiptHash)
      && typeof row.observeReceiptHash === 'string' && ID.test(row.observeReceiptHash)) anchoredClaims += 1
  }
  const unmarked = trajectories - unauthenticated - anchoredClaims
  return { trajectories, highSurprise, unreadableLines, unauthenticated, anchoredClaims, unmarked }
}

/** The host's wake timer, as it reported it. Times are what the host sent (ms or ISO); unknown fields are null. */
export interface WakeStatus {
  readonly enabled: boolean
  readonly intervalMs: number | null
  readonly lastWakeAt: number | string | null
  /** True only when the host says so outright: `lastWakeAt: null` and `wakeCount: 0`. */
  readonly neverWoke: boolean
  readonly lastWakeOutcome: string | null
  readonly wakeCount: number | null
  readonly nextWakeAt: number | string | null
  /** The newest wake receipt the host keeps (Round 24 read; both hosts keep the last few), or null when none is sent. */
  readonly lastReceipt: WakeReceipt | null
  /** The host turned the timer off itself after wakes nobody acknowledged (null when it does not say). */
  readonly autoPaused: boolean | null
  /** The edge's word on its alarm (`scheduled`, `disabled`, `alarm_missing`), or null when the host does not say. */
  readonly scheduleStatus: string | null
}
/** One wake receipt as the host keeps it (`wake-<seed>-<n>`, when, why, the Pearl it saw, and the outcome). */
export interface WakeReceipt {
  readonly wakeId: string | null
  readonly at: number | string | null
  readonly trigger: string | null
  readonly headEpoch: number | null
  readonly status: string | null
}

export type WakeRead =
  | { readonly kind: 'ok'; readonly status: WakeStatus }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'refused'; readonly status: number; readonly detail: string }

export type WakeFetch = (input: string, init: RequestInit) => Promise<Response>

const timeOf = (v: unknown): number | string | null =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v !== '') ? v : null
const countOf = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

function outcomeOf(v: unknown): string | null {
  if (typeof v === 'string') return v === '' ? null : v
  if (!isJson(v)) return null
  const word = [v.status, v.outcome, v.kind].find(w => typeof w === 'string' && w !== '') as string | undefined
  const detail = typeof v.detail === 'string' && v.detail !== '' ? v.detail : typeof v.error === 'string' && v.error !== '' ? v.error : null
  if (word === undefined) return detail
  return detail === null ? word : `${word}: ${detail}`
}

/** Read a wake answer; null when it is not one. `enabled` must be a boolean: a missing word is not "off". */
export function parseWake(body: unknown): WakeStatus | null {
  if (!isJson(body) || body.ok === false) return null
  const source = isJson(body.wake) ? body.wake : body
  if (typeof source.enabled !== 'boolean') return null
  const interval = countOf(source.intervalMs)
  return {
    enabled: source.enabled,
    intervalMs: interval,
    lastWakeAt: timeOf(source.lastWakeAt),
    neverWoke: source.lastWakeAt === null && source.wakeCount === 0,
    lastWakeOutcome: outcomeOf(source.lastWakeOutcome),
    wakeCount: countOf(source.wakeCount),
    nextWakeAt: timeOf(source.nextWakeAt),
    lastReceipt: receiptOf(Array.isArray(source.receipts) ? source.receipts.at(-1) : undefined),
    autoPaused: typeof source.autoPaused === 'boolean' ? source.autoPaused : null,
    scheduleStatus: typeof source.scheduleStatus === 'string' && /^[a-z_]{1,40}$/u.test(source.scheduleStatus) ? source.scheduleStatus : null,
  }
}
function receiptOf(value: unknown): WakeReceipt | null {
  if (!isJson(value)) return null
  const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length <= 160 ? v : null)
  return { wakeId: text(value.wakeId), at: timeOf(value.at), trigger: text(value.trigger), headEpoch: countOf(value.headEpoch),
    status: text(value.status) }
}

/**
 * The interval to ask for: the host's own when it is above the floor and in bounds, else the default. Both hosts seed
 * an unconfigured timer at the 60 s floor, so the floor itself is read as "not chosen yet".
 */
export function wakeInterval(status: WakeStatus | null): number {
  const ms = status?.intervalMs ?? null
  return ms !== null && ms > WAKE_MIN_MS && ms <= WAKE_MAX_MS ? ms : WAKE_DEFAULT_MS
}

const pageFetch: WakeFetch = (input, init) => globalThis.fetch(input, init)

async function wakeCall(init: RequestInit, fetchImpl: WakeFetch): Promise<WakeRead> {
  let response: Response
  try {
    response = await fetchImpl(WAKE_ROUTE, { credentials: 'same-origin', cache: 'no-store', ...init })
  } catch (error) {
    return { kind: 'refused', status: 0, detail: `${WAKE_ROUTE} unreachable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  // The host answers an unknown HTML path with its app page; a page is not this route. An HTML error page is a refusal.
  const html = (response.headers.get('content-type') ?? '').includes('text/html')
  if (response.status === 404 || (response.ok && html)) {
    return { kind: 'absent', detail: `${WAKE_ROUTE} is not served on this host (${String(response.status)})` }
  }
  if (html) return { kind: 'refused', status: response.status, detail: `HTTP ${String(response.status)}` }
  let body: unknown
  try { body = JSON.parse(raw) } catch { return { kind: 'refused', status: response.status, detail: `${WAKE_ROUTE} answered non-JSON` } }
  const said = isJson(body) ? [body.error, body.code, body.reason].find(w => typeof w === 'string' && w !== '') as string | undefined : undefined
  if (!response.ok || (isJson(body) && body.ok === false)) {
    return { kind: 'refused', status: response.status, detail: said ?? `HTTP ${String(response.status)}` }
  }
  const status = parseWake(body)
  return status === null ? { kind: 'refused', status: response.status, detail: 'the wake answer is not the expected shape' } : { kind: 'ok', status }
}

/** GET the wake timer. */
export function readWake(fetchImpl: WakeFetch = pageFetch): Promise<WakeRead> {
  return wakeCall({ method: 'GET' }, fetchImpl)
}

/**
 * What a wake button asks the host for. A configure without `intervalMs` keeps the host's stored interval (both hosts
 * merge it), which is how a pause leaves the interval as it was.
 */
export type WakeRequest =
  | { readonly action: 'trigger' }
  | { readonly action: 'configure'; readonly enabled: boolean; readonly intervalMs?: number }

/** POST one wake request; the host answers with the timer's state. */
export function postWake(request: WakeRequest, fetchImpl: WakeFetch = pageFetch): Promise<WakeRead> {
  if (request.action === 'configure' && request.intervalMs !== undefined
    && !(Number.isSafeInteger(request.intervalMs) && request.intervalMs >= WAKE_MIN_MS && request.intervalMs <= WAKE_MAX_MS)) {
    return Promise.resolve({ kind: 'refused', status: 0, detail: 'interval outside 60 s to 24 h; not sent' })
  }
  return wakeCall({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }, fetchImpl)
}

// ── LIVE: one page-wide listener for her ball commits and the host's pushes ──────────────────────────────────────

/** Her worker's ball broadcast channel (`ball-loader.ts`). */
export const BALLS_CHANNEL = 'aukora-x6-balls'
/** The host's head socket. */
export const HEAD_SOCKET_PATH = '/_head/ws'
/** How long a burst of events waits before one re-read. */
export const LIVE_DEBOUNCE_MS = 150
const RELEASE = /^[0-9a-f]{64}$/
const HOST_TYPES: ReadonlySet<string> = new Set(['mirror:updated', 'wake:updated', 'runtime:updated', 'head:staged', 'repo:staged', 'repo:merged'])

/** What a live message means to the surfaces. */
export type LiveEvent =
  | { readonly kind: 'ball-commit' }
  | { readonly kind: 'mirror-updated'; readonly changedPaths: readonly string[] | null }
  | { readonly kind: 'wake-updated'; readonly wake: WakeStatus | null }
  | { readonly kind: 'runtime-updated'; readonly releaseId: string; readonly buildSha: string | null }
  /**
   * HEAD took a candidate to hold for the owner (`POST /_head/stage`, Wave 3). Only the fact is taken from the push: what
   * is staged is always read back from HEAD itself (`GET /_head/promotion-status`), never from the frame.
   */
  | { readonly kind: 'head-staged' }
  /** HEAD took, or merged, a repo proposal for the owner (Wave 4). Only the fact: the proposal is read back from HEAD. */
  | { readonly kind: 'repo-staged' }
  | { readonly kind: 'repo-merged' }

/** Read one channel or socket message; anything else (presence, acks, unknown types) is null. */
export function parseLiveMessage(data: unknown): LiveEvent | null {
  let value = data
  if (typeof value === 'string') {
    // A ball frame carries every module's code: its type is read from the first bytes, and it is never parsed whole.
    const sniffed = /^\{\s*"(?:type|t)"\s*:\s*"([^"]{1,40})"/.exec(value.slice(0, 80))?.[1]
    if (sniffed === 'ball:commit' || sniffed === 'ball_announce') return { kind: 'ball-commit' }
    // Only the fact of a staging is taken; the frame's record is never read.
    if (sniffed === 'head:staged') return { kind: 'head-staged' }
    if (sniffed === 'repo:staged') return { kind: 'repo-staged' }
    if (sniffed === 'repo:merged') return { kind: 'repo-merged' }
    if (sniffed !== undefined && !HOST_TYPES.has(sniffed)) return null
    try { value = JSON.parse(value) as unknown } catch { return null }
  }
  if (!isJson(value)) return null
  const type = typeof value.type === 'string' ? value.type : typeof value.t === 'string' ? value.t : ''
  if (type === 'ball:commit' || type === 'ball_announce') return { kind: 'ball-commit' }
  if (type === 'mirror:updated') {
    const paths = Array.isArray(value.changedPaths) ? value.changedPaths.filter((p): p is string => typeof p === 'string') : null
    return { kind: 'mirror-updated', changedPaths: paths }
  }
  if (type === 'head:staged') return { kind: 'head-staged' }
  if (type === 'repo:staged') return { kind: 'repo-staged' }
  if (type === 'repo:merged') return { kind: 'repo-merged' }
  if (type === 'wake:updated') return { kind: 'wake-updated', wake: parseWake(isJson(value.wake) ? value.wake : null) }
  if (type === 'runtime:updated') {
    const body = isJson(value.runtime) ? value.runtime : value
    const releaseId = body.releaseId
    if (typeof releaseId !== 'string' || !RELEASE.test(releaseId)) return null
    return { kind: 'runtime-updated', releaseId, buildSha: typeof body.buildSha === 'string' && body.buildSha !== '' ? body.buildSha : null }
  }
  return null
}

/** True when a mirror change touches her home or her balls (or the host did not say what changed). */
export function touchesHer(paths: readonly string[] | null): boolean {
  return paths === null || paths.length === 0 || paths.some(p => /(?:^|\/)home\/(?:auma|balls)\//.test(p))
}

/** The pieces of a browser the listener needs, injectable for tests. */
export interface LiveDeps {
  readonly openChannel: (name: string) => LiveChannel | null
  readonly openSocket: (url: string) => LiveSocket | null
  readonly socketUrl: () => string | null
  readonly setTimer: (fn: () => void, ms: number) => unknown
  readonly clearTimer: (handle: unknown) => void
  readonly now?: () => number
}
export interface LiveChannel {
  onmessage: ((event: { data: unknown }) => void) | null
  close(): void
}
export interface LiveSocket {
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  close(): void
}
export interface LiveHub {
  subscribe(listener: (event: LiveEvent) => void): () => void
}

const RETRY_FIRST_MS = 3_000
const RETRY_MAX_MS = 30_000
/** After the last subscriber leaves, the listener stays open this long (a surface switch re-subscribes within it). */
const IDLE_STOP_MS = 1_000

/**
 * A listener that runs only while someone subscribes. The socket reconnects at 3 s, doubling to 30 s; the backoff
 * starts over only after a connection stayed up 30 s, so a socket that opens and drops at once cannot hammer the host.
 */
export function createLiveHub(deps: LiveDeps): LiveHub {
  const now = deps.now ?? (() => Date.now())
  const listeners = new Set<(event: LiveEvent) => void>()
  let channel: LiveChannel | null = null
  let socket: LiveSocket | null = null
  let retry: unknown = null
  let idle: unknown = null
  let running = false
  let delay = RETRY_FIRST_MS
  let firstConnect = true
  const emit = (data: unknown, fromHost: boolean): void => {
    const event = parseLiveMessage(data)
    if (event === null) return
    // The shared channel carries her ball commits; host facts are believed only from the host's socket.
    if (!fromHost && event.kind !== 'ball-commit') return
    for (const listener of [...listeners]) {
      try { listener(event) } catch { /* one surface's failure never stops the others */ }
    }
  }
  const connect = (): void => {
    retry = null
    const url = deps.socketUrl()
    if (url === null || !running) return
    let next: LiveSocket | null = null
    try { next = deps.openSocket(url) } catch { next = null }
    if (next === null) return
    socket = next
    // The host greets every new socket with the current head; on the first connect that is no news (the surfaces
    // just read it). After a reconnect it may be: commits can land while the socket was down.
    let snapshot = firstConnect
    firstConnect = false
    let openedAt: number | null = null
    next.onopen = () => { openedAt = now() }
    next.onmessage = (event) => {
      if (snapshot) {
        snapshot = false
        if (parseLiveMessage(event.data)?.kind === 'ball-commit') return
      }
      emit(event.data, true)
    }
    next.onclose = () => {
      if (socket === next) socket = null
      if (openedAt !== null && now() - openedAt >= RETRY_MAX_MS) delay = RETRY_FIRST_MS
      if (!running || retry !== null) return
      retry = deps.setTimer(connect, delay)
      delay = Math.min(delay * 2, RETRY_MAX_MS)
    }
  }
  const start = (): void => {
    running = true
    try { channel = deps.openChannel(BALLS_CHANNEL) } catch { channel = null }
    if (channel !== null) channel.onmessage = (event) => { emit(event.data, false) }
    delay = RETRY_FIRST_MS
    firstConnect = true
    connect()
  }
  const stop = (): void => {
    running = false
    if (channel !== null) { channel.onmessage = null; channel.close(); channel = null }
    if (retry !== null) { deps.clearTimer(retry); retry = null }
    const open = socket
    socket = null
    if (open !== null) { open.onclose = null; open.onmessage = null; open.close() }
  }
  return {
    subscribe(listener) {
      if (idle !== null) { deps.clearTimer(idle); idle = null }
      listeners.add(listener)
      if (!running) start()
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0 || idle !== null) return
        idle = deps.setTimer(() => { idle = null; if (listeners.size === 0) stop() }, IDLE_STOP_MS)
      }
    },
  }
}

const browserDeps: LiveDeps = {
  openChannel: name => (typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name) as unknown as LiveChannel),
  openSocket: url => (typeof WebSocket === 'undefined' ? null : new WebSocket(url) as unknown as LiveSocket),
  socketUrl: () => {
    const here = globalThis.location
    if (here === undefined || (here.protocol !== 'http:' && here.protocol !== 'https:')) return null
    const url = new URL(HEAD_SOCKET_PATH, here.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  now: () => Date.now(),
}

let pageHub: LiveHub | null = null
/** The page's one listener (created on first use). */
export function liveHub(): LiveHub {
  pageHub ??= createLiveHub(browserDeps)
  return pageHub
}

/** Call `onEvent` for each live event while `active`; the latest callback is used, without resubscribing. */
export function useLiveEvents(active: boolean, onEvent: (event: LiveEvent) => void, hub: LiveHub = liveHub()): void {
  const latest = useRef(onEvent)
  latest.current = onEvent
  useEffect(() => {
    if (!active) return
    return hub.subscribe((event) => { latest.current(event) })
  }, [active, hub])
}

/** Debounce bursts: `fire` runs once, `ms` after the last `poke`; pending runs are dropped on `cancel`. */
export interface Debounced {
  readonly poke: () => void
  /** Also fire once at each of these delays (a commit from another tab lands in her worker a moment later). */
  readonly followUp: (delays: readonly number[]) => void
  readonly cancel: () => void
}
/** Re-reads after a ball commit from elsewhere: her worker adopts it a moment later, so look again then. */
export const COMMIT_FOLLOW_UPS: readonly number[] = [1_500, 5_000]

export function useDebounced(fire: () => void, ms: number = LIVE_DEBOUNCE_MS): Debounced {
  const latest = useRef(fire)
  latest.current = fire
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const later = useRef<ReturnType<typeof setTimeout>[]>([])
  const handle = useRef<Debounced | null>(null)
  handle.current ??= {
    poke: () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => { timer.current = undefined; latest.current() }, ms)
    },
    followUp: (delays) => {
      for (const each of later.current) clearTimeout(each)
      later.current = delays.map(delay => setTimeout(() => { latest.current() }, delay))
    },
    cancel: () => {
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = undefined
      for (const each of later.current) clearTimeout(each)
      later.current = []
    },
  }
  useEffect(() => () => { handle.current?.cancel() }, [])
  return handle.current
}

// ── A NEW BUILD: the host selected a runtime release other than the one this page booted from ─────────────────────

/** The release this page booted from: the 64-hex id in its own `/_runtime/<id>/` module script URLs, or null. */
export function bootRelease(doc: Pick<Document, 'querySelectorAll'> | undefined = globalThis.document): string | null {
  if (doc === undefined) return null
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const match = /\/_runtime\/([0-9a-f]{64})\//.exec(script.getAttribute('src') ?? '')
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

/** The host's selected release from GET `/_head/runtime`, or null when it says none or cannot be read. */
export async function selectedRelease(fetchImpl: WakeFetch = pageFetch): Promise<string | null> {
  try {
    const response = await fetchImpl('/_head/runtime', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json() as unknown
    const selected = isJson(body) && isJson(body.selected) ? body.selected.releaseId : null
    return typeof selected === 'string' && RELEASE.test(selected) ? selected : null
  } catch { return null }
}

/** True on a candidate preview (`?runtime_candidate=`): that page is pinned to its release on purpose. */
function onCandidatePage(): boolean {
  try { return new URL(globalThis.location.href).searchParams.has('runtime_candidate') } catch { return false }
}

/**
 * A runtime release the host selected that differs from the one this page booted from, while `active`: read once
 * from `/_head/runtime` when the surface opens, then from `runtime:updated` pushes (a push wins over a slower read).
 * Different, not "newer": a selection can also be a rollback, and the host says a selection is no health proof.
 * Null when this page's own release cannot be told, or on a candidate preview page.
 */
export function useNewBuild(active: boolean, hub: LiveHub = liveHub(), fetchImpl: WakeFetch = pageFetch): string | null {
  const [release, setRelease] = useState<string | null>(null)
  const pushed = useRef(false)
  const differs = (id: string | null): string | null => {
    if (onCandidatePage()) return null
    const boot = bootRelease()
    return id !== null && boot !== null && id !== boot ? id : null
  }
  useEffect(() => {
    if (!active) return
    let live = true
    pushed.current = false
    void selectedRelease(fetchImpl).then((id) => { if (live && id !== null && !pushed.current) setRelease(differs(id)) })
    return () => { live = false }
  }, [active, fetchImpl])
  useLiveEvents(active, (event) => {
    if (event.kind !== 'runtime-updated') return
    pushed.current = true
    setRelease(differs(event.releaseId))
  }, hub)
  return release
}
