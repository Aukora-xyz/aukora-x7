// The edge's wall for a browser that only reads her (a window, never her body).
//
// A browser that never saved her is a READER (packages/experimental/webworker-runtime/src/storage/thread-sync.ts): its
// worker refuses every change it would send, and its page marks itself with the cookie `__Host-aukora_window=reader`
// (webworker-runtime/src/client/reader-window.ts). Page-owned controls (the Work page's "Wake now", the wake timer)
// never pass through the worker, so the page refuses them too, and this edge refuses every request that carries the mark
// and is on the closed list below: the routes a turn, a save, a wake, her voice or a thread line use, and the GETs that
// change her node (`/_head/promotion-status` can persist a published epoch; `/_head/transcript` can cancel a stale turn).
//
// Review: the name carries the `__Host-` prefix, so only this origin can set it (Secure, Path=/, no
// Domain): a cookie planted by any other example.invalid subdomain is never read. the list is closed, never a whole
// prefix: sign-in, sign-out, every AUMLOK route, his fingerprint routes (`/_head/promote`, `/_head/stage`, the night
// grant, `/_host/owner-grant`, `/_host/owner-key`), the brokers' Class 3 calls and every read stay open to a reader, and
// a publish or a provisioning that carries his approval is left to the route's own checks.
//
// The mark is read only while `THREAD_SYNC` is exactly `on` (thread-sync-mode.mjs
// `threadSyncOn`). With the switch unset, `pull`, `off` or anything else, a marked request is treated exactly as on main:
// nothing here refuses it, whatever cookie it carries.
//
// The mark can only make this edge refuse MORE; it never admits anything. A browser that strips its own mark is not
// stopped here: until her home records which browser holds her (North Star 26.3, N3) the edge cannot tell a window from
// her body by itself. Pure: header and path checks only, no storage, no session, no network. Cheap on every route.

import { threadSyncOn } from './thread-sync-mode.mjs'

/** The cookie a reader page sets; its only value is `reader`. `__Host-`: only her own origin can set it. */
export const READER_WINDOW_COOKIE = '__Host-aukora_window'

/** The header that carries his approval (Class 3); the route behind it checks the approval itself. */
export const READER_WINDOW_APPROVAL_HEADER = 'x-x6-class3-approval'

/** Model doors: every method is refused (even a door's GET spends: it reserves budget and calls the provider). */
export const READER_WINDOW_DOOR_PREFIX = '/door/'

/** Route families whose every write changes her node (her saved world, her mirror lease, her thread lines, her vault, her messages). */
// ---- reader window begin: close vault, message-queue, estate, relay, cell-run, web-eyes, head lease, and action-classified broker writes ----
export const READER_WINDOW_MAX_COOKIE_BYTES = 16384
export const READER_WINDOW_WRITE_PREFIXES = Object.freeze(['/_mirror/', '/_thread/', '/_vault/', '/aukora-messages/'])

/** Exact routes whose writes change her running node, her leases, or spend without a Class 3 card. */
export const READER_WINDOW_WRITE_ROUTES = Object.freeze([
  '/_host/wake', '/_host/estate', '/_host/crew-relay', '/_host/voice', '/_host/cloud-body',
  '/_host/cell-run', '/_host/web-eyes', '/api/body/run', '/aukora-messages', '/_bootstrap', '/_head/lease',
  '/_head/stage-withdraw', // Removes the staged head candidate without a Class 3 card
])

/** Exact routes whose unapproved calls are refused at the outer wall and whose approved calls are action-classified inside HEAD. */
export const READER_WINDOW_UNAPPROVED_WRITE_ROUTES = Object.freeze(['/_head/ball', '/_head/transcript'])
// ---- READER-WINDOW end ----

/** GETs that change her node (head-do.mjs). */
export const READER_WINDOW_REFUSED_GETS = Object.freeze(['/_head/promotion-status', '/_head/transcript'])

/** The sentence a refused reader request carries (the reader footer's own words). */
export const READER_WINDOW_SENTENCE = 'This browser only reads her: she answers in the browser that holds her home. Nothing sent from here changes her.'

/**
 * Whether this request carries the reader mark: a `Cookie` header with `__Host-aukora_window=reader` (any position,
 * exact). A plain `aukora_window` (which a sibling subdomain could set) is never read.
 * @param {Request} request
 * @returns {boolean}
 */
export function hasReaderMark(request) {
  const header = request.headers.get('cookie')
  if (header === null || header.length > READER_WINDOW_MAX_COOKIE_BYTES) return false
  return header.split(';').some(part => part.trim() === `${READER_WINDOW_COOKIE}=reader`)
}

/**
 * Whether a marked request with this method and path is on the closed list.
 * @param {string} method - upper case.
 * @param {string} path
 * @param {boolean} approved - it carries his approval header.
 * @returns {boolean}
 */
function refusedForReader(method, path, approved) {
  if (path.startsWith(READER_WINDOW_DOOR_PREFIX)) return true
  if (method === 'GET' || method === 'HEAD') return READER_WINDOW_REFUSED_GETS.includes(path)
  if (READER_WINDOW_WRITE_PREFIXES.some(prefix => path.startsWith(prefix))) return true
  if (READER_WINDOW_WRITE_ROUTES.includes(path)) return true
  return READER_WINDOW_UNAPPROVED_WRITE_ROUTES.includes(path) && !approved
}

// ---- reader window begin: shared reader-window predicate and refusal helpers for broker/HEAD action boundaries ----
/**
 * Whether this request must be treated as a reader window under `THREAD_SYNC = "on"`: either carrying
 * `__Host-aukora_window=reader` or carrying an oversized Cookie header (> 16 KiB) that could mask it.
 * @param {Request | null | undefined} request
 * @param {unknown} env
 * @returns {boolean}
 */
export function isReaderWindow(request, env) {
  if (!request || !threadSyncOn(env)) return false
  const cookie = request.headers.get('cookie')
  if (cookie !== null && cookie.length > READER_WINDOW_MAX_COOKIE_BYTES) return true
  return hasReaderMark(request)
}

export function readerWindowRefusalBody() {
  return { ok: false, code: 'READER_WINDOW', message: READER_WINDOW_SENTENCE }
}

export function readerWindowRefusalResponse() {
  return new Response(JSON.stringify(readerWindowRefusalBody()), {
    status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
}
// ---- READER-WINDOW end ----

/**
 * The refusal for a marked request that would change her node, or null (the request goes on unchanged). Null for every
 * request while thread sync is not switched on: the mark is not even read.
 * @param {Request} request
 * @param {URL} url
 * @param {unknown} env - The Worker env (`THREAD_SYNC`).
 * @returns {Response | null}
 */
export function readerWindowRefusal(request, url, env) {
  if (!isReaderWindow(request, env)) return null
  if (!refusedForReader(request.method.toUpperCase(), url.pathname, request.headers.has(READER_WINDOW_APPROVAL_HEADER))) return null
  void request.body?.cancel().catch(() => {})
  return readerWindowRefusalResponse()
}
