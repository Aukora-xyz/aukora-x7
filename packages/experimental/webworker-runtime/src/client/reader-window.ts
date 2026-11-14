/**
 * The page's half: a browser that only reads her refuses, in the page too, what would
 * change her node, and marks itself so her edge refuses it as well (deploy/cloudflare/src/reader-window.mjs).
 *
 * Her worker decides the role from local facts before any call (storage/thread-sync.ts) and posts it on
 * `BroadcastChannel('aukora-x6-thread-sync')`, each message carrying the page id this page gave it at init. This page
 * listens for its OWN worker only (another tab's line is never taken): on `role: 'reader'` it sets
 * `globalThis.__AUKORA_READER__` to the reader sentence (undefined otherwise; page controls read it and refuse,
 * autonomy.ts `postWake`) and the
 * cookie `__Host-aukora_window=reader` (her edge reads it); on any other role it clears both. At start it clears the
 * mark, so a browser that stops being a reader is never held by an old one. Nothing is stored but that one cookie; no
 * network. The `__Host-` prefix (always Secure, Path=/, no Domain) means only her own origin can set it: a sibling
 * example.invalid subdomain cannot plant a mark that locks her body out. Its `ask` carries this
 * page's id, so only its own worker answers it (review SHOULD 1: another tab's ask never re-marks this browser).
 * @module client/reader-window
 */

/** The channel her worker posts on (thread-sync.ts THREAD_SYNC_CHANNEL; the same words). */
export const READER_WINDOW_CHANNEL = 'aukora-x6-thread-sync'
/** The cookie her edge reads (`__Host-`: only this origin can set it; deploy/cloudflare/src/reader-window.mjs). */
export const READER_WINDOW_COOKIE = '__Host-aukora_window'
/** Where page code reads the reader sentence (a string while this page is a reader, else absent). */
export const READER_WINDOW_GLOBAL = '__AUKORA_READER__'
/** Where page code reads this page's id (the marks in the Threads lane show only their own worker's line). */
export const THREAD_SYNC_PAGE_GLOBAL = '__DSH_THREAD_SYNC_PAGE__'

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u

/** The parts of a page this module touches; tests pass their own. */
export interface ReaderWindowScope {
  readonly channel?: () => { postMessage(message: unknown): void; addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void; close(): void } | null
  readonly setCookie?: (cookie: string) => void
  readonly global?: Record<string, unknown>
}

/**
 * The `<meta name>` her edge adds to the boot document it serves, only while `THREAD_SYNC` is exactly `on`
 * (deploy/cloudflare/src/thread-sync-mode.mjs `threadSyncDocument`).
 */
export const THREAD_SYNC_META = 'aukora-thread-sync'

/** The smallest face of a document this module reads. */
export interface ThreadSyncDocument {
  querySelector(selectors: string): { getAttribute(name: string): string | null } | null
}

/**
 * The switch as this page's boot document carried it, read synchronously and with no request: `on` only
 * when the document holds `<meta name="aukora-thread-sync" content="on">`; null for no meta (the switch unset, or an old
 * document from before the meta existed), any other content, or no document. Never throws.
 */
export function servedThreadSync(doc: ThreadSyncDocument | null | undefined = (globalThis as { document?: ThreadSyncDocument }).document): 'on' | null {
  try {
    return doc?.querySelector(`meta[name="${THREAD_SYNC_META}"]`)?.getAttribute('content') === 'on' ? 'on' : null
  } catch {
    return null
  }
}

/**
 * The page's half of the boot: with the switch `on`, a page id and the reader window exactly as built
 * (`startReaderWindow`); with anything else, undefined, and nothing is minted, listened to, posted or set (no cookie
 * written, no global touched, no channel opened): the page boots as main.
 * @returns The page id to send its worker, or undefined while thread sync is switched off.
 */
export function startPageThreadSync(served: 'on' | null, scope: ReaderWindowScope = {}): string | undefined {
  if (served !== 'on') return undefined
  const pageId = mintPageId()
  startReaderWindow(pageId, scope)
  return pageId
}

/** A new page id: 16 random bytes, lowercase hex (the worker accepts 16 to 64 hex characters). */
export function mintPageId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Start listening for this page's own worker. Returns a stop function. Never throws.
 * @param pageId - The id this page sent its worker in the init frame.
 */
export function startReaderWindow(pageId: string, scope: ReaderWindowScope = {}): () => void {
  const target: Record<string, unknown> = scope.global ?? globalThis
  const writeCookie = scope.setCookie ?? ((cookie: string) => {
    const doc = (globalThis as { document?: { cookie: string } }).document
    if (doc !== undefined) doc.cookie = cookie
  })
  // `__Host-` requires Secure, Path=/ and no Domain; a page served over plain http cannot set it (its own controls
  // still refuse).
  const attributes = '; Path=/; Secure; SameSite=Strict'
  const mark = (footer: string | null): void => {
    try {
      if (footer === null) {
        target[READER_WINDOW_GLOBAL] = undefined
        writeCookie(`${READER_WINDOW_COOKIE}=; Max-Age=0${attributes}`)
      } else {
        target[READER_WINDOW_GLOBAL] = footer
        writeCookie(`${READER_WINDOW_COOKIE}=reader${attributes}`)
      }
    } catch { /* a page that cannot set cookies still refuses in its own controls */ }
  }
  target[THREAD_SYNC_PAGE_GLOBAL] = pageId
  mark(null)
  let channel: ReturnType<NonNullable<ReaderWindowScope['channel']>> = null
  try {
    channel = (scope.channel ?? (() => {
      const Channel = (globalThis as { BroadcastChannel?: new (name: string) => NonNullable<typeof channel> }).BroadcastChannel
      return typeof Channel === 'function' ? new Channel(READER_WINDOW_CHANNEL) : null
    }))()
  } catch { channel = null }
  if (channel === null) return () => {}
  let latest = -1
  channel.addEventListener('message', (event) => {
    const data = event.data as Record<string, unknown> | null
    if (data === null || typeof data !== 'object' || data.v !== 1 || data.kind !== 'state' || data.worker !== pageId) return
    if (typeof data.at !== 'number' || !Number.isSafeInteger(data.at) || data.at < latest) return
    if (typeof data.footer !== 'string' || data.footer.length > 200 || CONTROL.test(data.footer)) return
    latest = data.at
    mark(data.role === 'reader' ? (data.footer === '' ? 'This browser only reads her.' : data.footer) : null)
  })
  try { channel.postMessage({ v: 1, kind: 'ask', worker: pageId }) } catch { /* the worker answers when it posts */ }
  const open = channel
  return () => { try { open.close() } catch { /* closed */ } }
}
