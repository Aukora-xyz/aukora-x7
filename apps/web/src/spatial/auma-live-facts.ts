/**
 * AUMA LIVE'S STATUS READS, ANSWERED IN THE PAGE.
 *
 * The Spatial frame reads `/api/auma-live/status` and `/api/auma-live/minds` every 30 s while Auma Live is open
 * (`ui-layout/src/client/spatial/AppFrame.tsx`, paths in `auma-status.ts`). No host defines either route: the edge
 * answered 501 every time and the strip said "unknown" for everything. This module answers both in the page, from
 * facts the edge already publishes to the signed-in owner, and from nothing else:
 *
 * - edgeProviderKeys: the providers the edge has a key configured for (`GET /api/health` →
 *   `capabilities.providerDoors`). That is ALL it says: a configured key is not a hand that resolves (a revoked or
 *   blank key is still counted by the health answer), so it is never sent as `hands`, and the strip says "edge provider
 *   keys configured". A key stored on the Models page may add more, which the edge cannot see.
 * - lastWake: the edge's last wake outcome and time (`GET /_host/wake` → `lastWakeOutcome`, `lastWakeAt`, the HEAD's
 *   wake view), when she has woken. Never the estate projection, which adds R2 lists to every poll and fails whole when
 *   any part of it does. (Each edge request still costs its own bootstrap reads; see the cost note below.)
 * - everything else (her home session, CORE, today's spend in dollars, who is waiting on the owner) is left OUT of the
 *   answer, so the strip keeps saying "unknown" for it. The edge counts provider requests, not dollars, and keeps no
 *   lane approval log; a zero or an empty list here would be a guess, and the strip's rule is that an unknown is never
 *   a green.
 *
 * A failed read leaves its fields out, and nothing is written. COST: the frame polls every 30 s; here, at most one
 * refresh is in flight (a poll that arrives meanwhile shares it), the wake is read on each refresh, a successful health
 * answer is reused for {@link EDGE_HEALTH_REUSE_MS} (its doors change only when a key is set), a failed one is not,
 * and WHILE THE PAGE IS HIDDEN nothing is read at all: the poll gets the last answer again, or only the source label
 * (every fact unknown) if there is none yet. Reading resumes on the first poll after the page is shown.
 * Only these two exact GET paths on this origin are answered. Every other request goes to the network unchanged.
 * @module apps/web/src/spatial/auma-live-facts
 */

/** The status path the frame reads (equal to `AUMA_STATUS_PATH` in ui-layout's auma-status.ts; a spec holds them equal). */
export const AUMA_LIVE_STATUS_PATH = '/api/auma-live/status'
/** The minds path the frame reads (equal to `AUMA_MINDS_PATH`). */
export const AUMA_LIVE_MINDS_PATH = '/api/auma-live/minds'
/** The edge facts the status answer is built from. */
export const EDGE_HEALTH_PATH = '/api/health'
export const EDGE_WAKE_PATH = '/_host/wake'
/** How long a successful `/api/health` answer is reused across polls (the strip polls every 30 s). */
export const EDGE_HEALTH_REUSE_MS = 5 * 60_000

const INSTALLED = Symbol.for('aukora.auma-live-facts')

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * Build the status answer from the two edge facts. Pure: specs drive it with fixtures.
 * @param health - The parsed `/api/health` body, or null when it could not be read.
 * @param wake - The parsed `GET /_host/wake` body, or null when it could not be read.
 * @returns The answer, carrying only fields the facts establish.
 */
export function statusFromEdgeFacts(health: unknown, wake: unknown): Record<string, unknown> {
  const answer: Record<string, unknown> = { source: 'page: from edge facts' }
  const doors = record(record(record(health)?.capabilities)?.providerDoors)
  if (doors !== null) answer.edgeProviderKeys = Object.keys(doors).filter(name => doors[name] === true).sort()
  const view = record(wake)
  const outcome = view?.lastWakeOutcome
  if (typeof outcome === 'string' && /^[a-z_]{1,64}$/.test(outcome)) {
    const at = view?.lastWakeAt
    answer.lastWake = {
      decision: outcome.replace(/_/g, ' '),
      ...(typeof at === 'number' && Number.isSafeInteger(at) && at > 0 ? { at: new Date(at).toISOString() } : {}),
    }
  }
  return answer
}

/** The minds answer: no `waiting` field, because no host keeps the lanes' approval log (so the badge stays unknown). */
export function mindsFromPage(): Record<string, unknown> {
  return { source: 'page: no host keeps the lane approval log' }
}

type FetchScope = {
  fetch: typeof fetch
  location?: { origin: string }
  /** The page's document: only its visibility is read. */
  document?: { readonly visibilityState?: string }
  now?: () => number
  [INSTALLED]?: true
}

function answered(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Wrap the page's fetch so the two Auma Live status reads are answered here. Idempotent.
 * @param scope - The page global; specs pass their own.
 */
export function installAumaLiveFacts(scope: FetchScope = globalThis): void {
  if (scope[INSTALLED] === true || typeof scope.fetch !== 'function' || scope.location === undefined) return
  scope[INSTALLED] = true
  const network = scope.fetch.bind(globalThis)
  const origin = scope.location.origin
  const now = scope.now ?? Date.now
  let health: { readonly body: unknown; readonly at: number } | null = null
  /** The last answer built, given again while the page is hidden. */
  let last: Record<string, unknown> | null = null
  /** The refresh in flight, shared by every poll that arrives before it settles. */
  let refreshing: Promise<Record<string, unknown>> | null = null
  const hidden = (): boolean => scope.document?.visibilityState === 'hidden'
  const readJson = async (path: string): Promise<unknown> => {
    try {
      const response = await network(new URL(path, origin).href, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return null
      const body: unknown = await response.json()
      return body
    } catch {
      return null
    }
  }
  const readHealth = async (): Promise<unknown> => {
    if (health !== null && now() - health.at < EDGE_HEALTH_REUSE_MS) return health.body
    const body = await readJson(EDGE_HEALTH_PATH)
    health = body === null ? null : { body, at: now() }
    return body
  }
  scope.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = typeof Request === 'function' && input instanceof Request ? input : null
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    let url: URL | null = null
    try { url = new URL(request?.url ?? (input instanceof URL ? input.href : input as string), origin) } catch { url = null }
    if (method === 'GET' && url !== null && url.origin === origin) {
      if (url.pathname === AUMA_LIVE_STATUS_PATH) {
        if (hidden()) return Promise.resolve(answered(last ?? statusFromEdgeFacts(null, null)))
        refreshing ??= Promise.all([readHealth(), readJson(EDGE_WAKE_PATH)])
          .then(([doors, wake]) => { last = statusFromEdgeFacts(doors, wake); return last })
          .finally(() => { refreshing = null })
        return refreshing.then(answered)
      }
      if (url.pathname === AUMA_LIVE_MINDS_PATH) return Promise.resolve(answered(mindsFromPage()))
    }
    return network(input, init)
  }
}
