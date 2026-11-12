// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * ONE RELOAD BUTTON FOR TWO TRUTHS. The owner sees, without asking, when this page is behind, through
 * the existing "Reload" button (`work/WorkSurface.tsx` `NewBuildButton`), one sentence each:
 *
 *   A NEWER AUMA IS PUBLISHED. An open tab never hot-swaps to a head published elsewhere;
 *     her runtime records the published head and answers `GET /__x6__/head-lag` through this page's
 *     tunnel (ball-loader.ts). That read is local to the tab: no network, constant size. Polled every 15 s while the
 *     surface is open and the page visible.
 *   A NEW BUILD OF THE APP IS LIVE. The page's own build stamp (apps/web/vite.config.ts `stampRuntimeBuild`; a dirty
 *     or unstamped build names nothing, and then nothing is shown) against the edge's
 *     signed-out constant-cost `GET /api/build` `{ ok, schema, sourceRevision }`: at most once a minute,
 *     only while visible, one request at a time, each with a deadline; once a difference is shown, polling stops.
 *   NO FALSE NOTICE THAT SURVIVES A RELOAD. A press records the edge revision it reloads for (session storage). If the
 *     reloaded page still differs from that same edge revision (a hand-stamped deploy whose `SOURCE_REVISION` is not the
 *     bundle it serves), the notice for that revision is not shown again this session, and the mismatch is reported to
 *     her runtime (`POST /__x6__/build-mismatch`), where `GET /__x6__/status` shows it as `buildMismatch`.
 *
 *   WHERE THE PAGE'S STAMP COMES FROM. This library ships inside the app image and is loaded at run time,
 *     never bundled by apps/web, so the bundler define `__X6_BUILD_IDENTITY__` is never replaced in it (a bare word,
 *     `typeof` "undefined" on the live page: the notice was dead in production while unit specs passed). The stamped
 *     page bootstrap (apps/web/src/preview.ts) publishes the stamp once, frozen, as `globalThis.__X6_PAGE_BUILD__`
 *     before the image loads; that is what is read here. deploy/ci/built-notice-check.mjs proves it on a built dist.
 *
 * The page's idle-deadline fetch (`webworker-runtime/src/idle-fetch.ts`) is not a dependency of this package; both
 * answers here are a few dozen constant bytes, so a total deadline over headers and body is the same bound.
 * @module portal/build-notice
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

declare const __X6_BUILD_IDENTITY__: { readonly sourceRevision?: string | null; readonly sourceDirty?: boolean | null } | undefined

/** The edge's signed-out build route. */
export const EDGE_BUILD_ROUTE = '/api/build'
/** Never more often than this. */
export const EDGE_BUILD_POLL_MS = 60_000
/** One read gets this long, headers and body together. */
export const EDGE_BUILD_DEADLINE_MS = 10_000
/** A build answer larger than this is not the constant-size answer the edge sends. */
export const EDGE_BUILD_MAX_BYTES = 4096
/** What the notice says when the edge serves a different build than this page runs. */
export const EDGE_BUILD_WORDS = Object.freeze({
  button: 'New build · Reload',
  what: 'A new build of the app is live. One reload brings it.',
})

const PAGE_REVISION = /^[0-9a-f]{40}$/
// The edge accepts a 40..64 hex SOURCE_REVISION (deploy/cloudflare/src/worker.mjs `sourceRevision`).
const EDGE_REVISION = /^[0-9a-f]{40,64}$/

type BuildStamp = { readonly sourceRevision?: string | null; readonly sourceDirty?: boolean | null } | null | undefined

/**
 * The global the page bootstrap (apps/web/src/preview.ts) sets once, frozen and non-configurable, before the app image
 * loads: `{ sourceRevision, sourceDirty }` from its own bundler stamp. Keep the name in step with that file.
 */
export const PAGE_BUILD_GLOBAL = '__X6_PAGE_BUILD__'

/**
 * This page's build stamp: the bundler define where this code was bundled with one, else the bootstrap's published
 * stamp, else nothing.
 */
export function pageBuildStamp(): BuildStamp {
  if (typeof __X6_BUILD_IDENTITY__ !== 'undefined') return __X6_BUILD_IDENTITY__
  try {
    const published = (globalThis as Record<string, unknown>)[PAGE_BUILD_GLOBAL]
    return published !== null && typeof published === 'object' ? published : undefined
  } catch { return undefined }
}

/**
 * The commit this page was built from, or null when the build has no stamp, a malformed one, or a dirty tree.
 * @param stamp - The build's stamp; defaults to {@link pageBuildStamp}.
 */
export function pageSourceRevision(stamp: BuildStamp = pageBuildStamp()): string | null {
  if (stamp == null || stamp.sourceDirty !== false) return null
  return typeof stamp.sourceRevision === 'string' && PAGE_REVISION.test(stamp.sourceRevision) ? stamp.sourceRevision : null
}

/** The edge's revision from a `/api/build` body, or null for anything that is not that answer. */
export function parseEdgeBuild(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (value.ok !== true || typeof value.schema !== 'string') return null
  return typeof value.sourceRevision === 'string' && EDGE_REVISION.test(value.sourceRevision) ? value.sourceRevision : null
}

/** The edge's revision when both are known and differ, else null (unknown is never shown as changed). */
export function edgeBuildChange(page: string | null, edge: string | null): string | null {
  return page !== null && edge !== null && edge !== page ? edge : null
}

export type BuildFetch = (input: string, init: RequestInit) => Promise<Response>

/**
 * One bounded read of `/api/build`.
 * @returns The edge's revision, or null when it cannot be read in time or the answer is not a build answer.
 */
export async function readEdgeBuild(
  fetchImpl: BuildFetch = (input, init) => fetch(input, init), deadlineMs: number = EDGE_BUILD_DEADLINE_MS,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, deadlineMs)
  try {
    const response = await fetchImpl(EDGE_BUILD_ROUTE, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > EDGE_BUILD_MAX_BYTES) {
      await response.body?.cancel().catch(() => {})
      return null
    }
    const text = await response.text()
    if (text.length > EDGE_BUILD_MAX_BYTES) return null
    return parseEdgeBuild(JSON.parse(text) as unknown)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** The part of the page's document this hook reads: its visibility, and the event that says it changed. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** This page's own tunnel to her runtime (`__DSH_TRANSPORT__.fetch`, as the Work bridge uses it). */
export type PageTunnel = (input: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<{ readonly status: number; text(): Promise<string> }>

/** The page tunnel, or null where there is none (a page without her runtime, a server render). */
export function pageTunnel(): PageTunnel | null {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { fetch?: PageTunnel } }).__DSH_TRANSPORT__
  return typeof transport?.fetch === 'function' ? transport.fetch.bind(transport) : null
}

/** Session memory for the reload rule: the edge revision a press reloads for, and the revisions not shown again. */
export interface BuildMemory {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
/** The edge revision the owner's last press reloaded the page for (written just before the reload). */
export const BUILD_RELOAD_FOR_KEY = 'aukora.x6.build.reloadFor'
/** An edge revision whose notice already failed to go away after a reload: not shown again this session. */
export const BUILD_SUPPRESSED_KEY = 'aukora.x6.build.suppressed'
/** Her runtime's record of the mismatch, which `GET /__x6__/status` shows (ball-loader.ts). */
export const BUILD_MISMATCH_ROUTE = '/__x6__/build-mismatch'

function sessionMemory(): BuildMemory | null {
  try { return (globalThis as { sessionStorage?: BuildMemory }).sessionStorage ?? null } catch { return null }
}
function memoryGet(memory: BuildMemory | null, key: string): string | null {
  try { return memory?.getItem(key) ?? null } catch { return null }
}

/**
 * Remember, for the page this press is about to load, which edge revision the press reloaded for.
 * @param edge - The edge revision the notice showed.
 */
export function markBuildReload(edge: string, memory: BuildMemory | null = sessionMemory()): void {
  try { memory?.setItem(BUILD_RELOAD_FOR_KEY, edge) } catch { /* no session storage: the notice may show again */ }
}

/**
 * What this page does with one known edge revision. 'same': nothing to say. 'show': the notice. 'suppressed': this
 * session already saw a reload fail to bring it. 'mismatch': the press that loaded THIS page was for this very revision
 * and the page still differs: it is suppressed from now on and must be reported. The press mark is consumed by the
 * first known answer, whatever it says.
 */
export function settleEdgeBuild(page: string, edge: string, memory: BuildMemory | null = sessionMemory()): 'same' | 'show' | 'suppressed' | 'mismatch' {
  const pressedFor = memoryGet(memory, BUILD_RELOAD_FOR_KEY)
  if (pressedFor !== null) { try { memory?.removeItem(BUILD_RELOAD_FOR_KEY) } catch { /* nothing to undo */ } }
  if (edge === page) return 'same'
  if (memoryGet(memory, BUILD_SUPPRESSED_KEY) === edge) return 'suppressed'
  if (pressedFor !== edge) return 'show'
  try { memory?.setItem(BUILD_SUPPRESSED_KEY, edge) } catch { /* the in-page answer below still holds */ }
  return 'mismatch'
}

/** Tell her runtime, so `/__x6__/status` shows it. Best effort: a page without her runtime just keeps quiet. */
export async function reportBuildMismatch(page: string, edge: string, tunnel: PageTunnel | null = pageTunnel()): Promise<void> {
  if (tunnel === null) return
  try {
    const answer = await tunnel(BUILD_MISMATCH_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page, edge }) })
    await answer.text()
  } catch { /* status simply does not show it */ }
}

export interface EdgeBuildOptions {
  readonly fetchImpl?: BuildFetch
  /** This page's revision; defaults to the build stamp. */
  readonly pageRevision?: string | null
  readonly intervalMs?: number
  readonly doc?: VisibilitySource
  /** Session memory for the reload rule; defaults to `sessionStorage`. */
  readonly memory?: BuildMemory | null
  /** Where a mismatch is reported; defaults to the page tunnel. */
  readonly tunnel?: PageTunnel | null
}

/**
 * The edge's revision while `active`, when it differs from the one this page was built from and a reload for it has not
 * already failed this session; else null. Reads once when it opens (if visible), then at most once per `intervalMs`
 * while visible; stops once a difference is shown.
 */
export function useEdgeBuild(active: boolean, options: EdgeBuildOptions = {}): string | null {
  const [changed, setChanged] = useState<string | null>(null)
  const { intervalMs = EDGE_BUILD_POLL_MS } = options
  // Kept across renders and effect restarts: a re-render never buys an extra read inside the interval.
  const lastAt = useRef(Number.NEGATIVE_INFINITY)
  const fetchRef = useRef(options.fetchImpl)
  fetchRef.current = options.fetchImpl
  const sideRef = useRef({ memory: options.memory, tunnel: options.tunnel })
  sideRef.current = { memory: options.memory, tunnel: options.tunnel }
  const page = options.pageRevision === undefined ? pageSourceRevision() : options.pageRevision
  // Undefined where there is no page (a worker or a server render): nothing is read there.
  const doc = options.doc ?? (globalThis as { document?: VisibilitySource }).document
  useEffect(() => {
    if (!active || page === null || changed !== null || doc === undefined) return
    let live = true
    let busy = false
    // Read through a call: the cleanup below may end this effect while a read is awaited.
    const ended = (): boolean => !live
    let timer: ReturnType<typeof setTimeout> | undefined
    const visible = (): boolean => doc.visibilityState === 'visible'
    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (!live || !visible()) return
      timer = setTimeout(() => { void read() }, Math.max(0, lastAt.current + intervalMs - Date.now()))
    }
    const read = async (): Promise<void> => {
      if (!live || busy || !visible() || Date.now() - lastAt.current < intervalMs) { schedule(); return }
      busy = true
      lastAt.current = Date.now()
      const edge = await readEdgeBuild(fetchRef.current)
      busy = false
      if (ended()) return
      if (edge !== null) {
        const { memory, tunnel } = sideRef.current
        const verdict = settleEdgeBuild(page, edge, memory === undefined ? sessionMemory() : memory)
        if (verdict === 'show') { setChanged(edge); return }
        if (verdict === 'mismatch') void reportBuildMismatch(page, edge, tunnel === undefined ? pageTunnel() : tunnel)
      }
      schedule()
    }
    const onVisibility = (): void => {
      if (visible()) void read()
      else if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    }
    doc.addEventListener('visibilitychange', onVisibility)
    void read()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
      doc.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, page, changed, doc, intervalMs])
  return changed
}

/** Her runtime's record of the published head (ball-loader.ts `currentHeadLag`), local to this tab. */
export const HEAD_LAG_ROUTE = '/__x6__/head-lag'
/** The tab's own record costs no network: read every 15 s while the surface is open and the page visible. */
export const HEAD_LAG_POLL_MS = 15_000
const HEAD_LAG_DEADLINE_MS = 5_000
const BALL_ID = /^[0-9a-f]{64}$/

/** A published head this tab does not run: the two heads, and whether the published one is newer. */
export interface HeadLagNotice {
  readonly published: { readonly ballId: string; readonly epoch: number }
  readonly running: { readonly ballId: string; readonly epoch: number }
  readonly newer: boolean
}

const headRef = (value: unknown): { ballId: string; epoch: number } | null => {
  if (value === null || typeof value !== 'object') return null
  const { ballId, epoch } = value as { ballId?: unknown; epoch?: unknown }
  return typeof ballId === 'string' && BALL_ID.test(ballId) && Number.isSafeInteger(epoch) && Number(epoch) >= 0
    ? { ballId, epoch: Number(epoch) } : null
}

/** The lag from a `/__x6__/head-lag` body, or null for no lag or anything that is not that answer. */
export function parseHeadLag(body: unknown): HeadLagNotice | null {
  if (body === null || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) return null
  const lag = (body as { headLag?: unknown }).headLag
  if (lag === null || typeof lag !== 'object') return null
  const published = headRef((lag as { published?: unknown }).published)
  const running = headRef((lag as { running?: unknown }).running)
  if (published === null || running === null || published.ballId === running.ballId) return null
  return { published, running, newer: published.epoch > running.epoch }
}

/** One read of her runtime's lag record, bounded; null when there is no lag or it cannot be read. */
export async function readHeadLag(
  tunnel: PageTunnel | null = pageTunnel(), deadlineMs: number = HEAD_LAG_DEADLINE_MS,
): Promise<HeadLagNotice | null> {
  if (tunnel === null) return null
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null) }, deadlineMs) })
  const read = (async (): Promise<HeadLagNotice | null> => {
    const answer = await tunnel(HEAD_LAG_ROUTE, { method: 'GET', signal: controller.signal })
    if (answer.status !== 200) return null
    const text = await answer.text()
    return text.length > EDGE_BUILD_MAX_BYTES ? null : parseHeadLag(JSON.parse(text) as unknown)
  })().catch(() => null)
  try { return await Promise.race([read, deadline]) } finally { clearTimeout(timer) }
}

export interface HeadLagOptions {
  readonly tunnel?: PageTunnel | null
  readonly intervalMs?: number
  readonly doc?: VisibilitySource
}

const sameLag = (a: HeadLagNotice | null, b: HeadLagNotice | null): boolean => a === b || (a !== null && b !== null
  && a.published.ballId === b.published.ballId && a.published.epoch === b.published.epoch && a.running.ballId === b.running.ballId)

/** Her published head while `active`, when this tab does not run it; else null. Read at once, then every `intervalMs`. */
export function useHeadLag(active: boolean, options: HeadLagOptions = {}): HeadLagNotice | null {
  const [lag, setLag] = useState<HeadLagNotice | null>(null)
  const { intervalMs = HEAD_LAG_POLL_MS } = options
  const tunnelRef = useRef(options.tunnel)
  tunnelRef.current = options.tunnel
  const doc = options.doc ?? (globalThis as { document?: VisibilitySource }).document
  useEffect(() => {
    if (!active || doc === undefined) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      timer = undefined
      if (doc.visibilityState === 'visible') {
        const next = await readHeadLag(tunnelRef.current === undefined ? pageTunnel() : tunnelRef.current)
        if (!live) return
        setLag(previous => (sameLag(previous, next) ? previous : next))
      }
      if (live) timer = setTimeout(() => { void read() }, intervalMs)
    }
    void read()
    return () => { live = false; if (timer !== undefined) clearTimeout(timer) }
  }, [active, doc, intervalMs])
  return lag
}

/** The words for a published head this tab does not run. */
export function headLagWords(lag: HeadLagNotice): { readonly button: string; readonly what: string } {
  const next = String(lag.published.epoch), mine = String(lag.running.epoch)
  return lag.newer
    ? { button: `Newer Auma · epoch ${next} · Reload`, what: `A newer Auma is published (epoch ${next}); this tab runs epoch ${mine}. One reload brings her.` }
    : { button: `Published Auma · epoch ${next} · Reload`, what: `The published Auma (epoch ${next}) is not the one this tab runs (epoch ${mine}). One reload takes the published one.` }
}

/** What the Reload button shows and does: the page reloads (its press first remembers an edge build it reloads for). */
export interface ReloadNotice {
  readonly release: string
  readonly words: { readonly button: string; readonly what: string }
  /** What this page runs, for the button's title. */
  readonly from: string | null
  readonly reload: () => void
}

/** How the page reloads; a test replaces it (jsdom cannot navigate). */
export const pageReload = { now: (): void => { globalThis.location.reload() } }

// ── NO RELOAD OVER AN APPROVAL IN FLIGHT (review ui3, SHOULD) ──
// The owner approves, finishes Touch ID, and the approved request is still awaiting its answer: a Reload then would drop
// the outcome before this page records it (an outward post is marked "sent here" only after its answer). Every approval
// on this page holds this one guard from the start of its ceremony until its request settles (success, refusal or
// error), and releases it in a `finally`. Every Reload button's handler checks it. A hold ends by itself after a fixed
// bound, so Reload is never dead for good.

/** The longest one hold keeps Reload waiting: a passkey challenge lives two minutes, and its request follows it. */
export const APPROVAL_RELOAD_HOLD_MAX_MS = 180_000
/** What the notice says while an approval holds Reload. */
export const APPROVAL_FINISHING_WORDS = 'An approval is finishing; Reload waits for its answer.'

const reloadHolds = new Set<symbol>()
const reloadHoldListeners = new Set<() => void>()
const reloadHoldChanged = (): void => { for (const listener of [...reloadHoldListeners]) listener() }

/**
 * Hold Reload for one approval, from the start of its ceremony.
 * @param maxMs - the hold's fixed bound; it releases itself then.
 * @returns the release, for the approval's `finally`; calling it again does nothing.
 */
export function holdReload(maxMs: number = APPROVAL_RELOAD_HOLD_MAX_MS): () => void {
  const hold = Symbol('approval')
  reloadHolds.add(hold)
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    clearTimeout(bound)
    if (reloadHolds.delete(hold)) reloadHoldChanged()
  }
  const bound = setTimeout(release, maxMs)
  reloadHoldChanged()
  return release
}

/** Whether an approval on this page is between its ceremony's start and its request's answer. */
export function reloadHeld(): boolean {
  return reloadHolds.size > 0
}

function subscribeReloadHold(listener: () => void): () => void {
  reloadHoldListeners.add(listener)
  return () => { reloadHoldListeners.delete(listener) }
}

/** Whether Reload waits for an approval now, for the notice that says so. */
export function useReloadHeld(): boolean {
  return useSyncExternalStore(subscribeReloadHold, reloadHeld, () => false)
}

/**
 * Reload the page unless an approval holds it.
 * @returns whether the page reloads.
 */
export function reloadUnlessHeld(): boolean {
  if (reloadHeld()) return false
  pageReload.now()
  return true
}

/** Tests only: drop every hold. */
export function resetReloadHoldsForTests(): void {
  reloadHolds.clear()
  reloadHoldChanged()
}

/**
 * One notice from the two causes; null when neither holds. One reload settles both, so both sentences are said.
 * @param edge - the edge build this page does not run, from {@link useEdgeBuild}.
 * @param lag - her published head this tab does not run, from {@link useHeadLag}.
 */
export function reloadNoticeOf(edge: string | null, lag: HeadLagNotice | null, page: string | null,
  memory?: BuildMemory | null): ReloadNotice | null {
  if (edge === null && lag === null) return null
  const lagWords = lag === null ? null : headLagWords(lag)
  const what = [edge === null ? null : EDGE_BUILD_WORDS.what, lagWords?.what ?? null].filter(text => text !== null).join(' ')
  return {
    release: edge ?? lag?.published.ballId ?? '',
    words: { button: edge !== null ? EDGE_BUILD_WORDS.button : lagWords?.button ?? EDGE_BUILD_WORDS.button, what },
    from: edge !== null ? page : lag?.running.ballId ?? null,
    reload: () => {
      // AN APPROVAL IN FLIGHT KEEPS THE PAGE (above): nothing is marked and nothing reloads until it settles.
      if (reloadHeld()) return
      if (edge !== null) markBuildReload(edge, memory === undefined ? sessionMemory() : memory)
      reloadUnlessHeld()
    },
  }
}

/** Both notices for one mounted surface, through its existing Reload button. */
export function useReloadNotice(
  active: boolean, options: { readonly edge?: EdgeBuildOptions; readonly lag?: HeadLagOptions } = {},
): ReloadNotice | null {
  const edge = useEdgeBuild(active, options.edge)
  const lag = useHeadLag(active, options.lag)
  const page = options.edge?.pageRevision === undefined ? pageSourceRevision() : options.edge.pageRevision
  const memory = options.edge?.memory
  return useMemo(() => reloadNoticeOf(edge, lag, page, memory), [edge, lag, page, memory])
}
