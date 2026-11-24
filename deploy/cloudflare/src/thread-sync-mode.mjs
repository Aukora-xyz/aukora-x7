/**
 * The one setting that tells her app whether thread sync is off, may pull, or is on.
 *
 * The deployment sets `THREAD_SYNC` under `[vars]`. Exactly `pull` gives `'pull'`, exactly `on` gives `'on'`; anything
 * else (unset, empty, another case, spaces, a number, an object, no env at all) gives `'off'`, so a typo can only ever
 * mean off. The value is served as `sync` on every page of `GET /_thread/index` (mirror-do.mjs, the `THREAD-SYNC hook` line).
 * It is read from env, never from storage, so it costs no read.
 *
 * Her app runs thread sync only when the boot document says so. While the mode is
 * exactly `on`, `threadSyncDocument` adds one `<meta name="aukora-thread-sync" content="on">` to the boot document the
 * Worker serves (worker.mjs, the `THREADSYNC hook` line), and the page reads it synchronously before it starts its
 * worker (webworker-runtime client/reader-window.ts `servedThreadSync`). In every other mode (`pull` included) the
 * document is served byte for byte as main serves it, the page runs nothing of thread sync, and the reader mark is not
 * read (reader-window.mjs): the edge refuses nothing it accepts on main.
 * @module thread-sync-mode
 */

/** The three words the index may carry, and nothing else. */
export const THREAD_SYNC_MODES = Object.freeze(['off', 'pull', 'on'])

/**
 * The thread sync mode this deployment declares.
 * @param {unknown} env The Worker or Durable Object env.
 * @returns {'off' | 'pull' | 'on'}
 */
export function threadSyncMode(env) {
  // Read as world-lease.mjs reads WRITER_LEASE (`env?.NAME`): the Workers env carries vars as plain properties.
  if (env === null || typeof env !== 'object') return 'off'
  const value = /** @type {Record<string, unknown>} */ (env).THREAD_SYNC
  if (value === 'pull') return 'pull'
  if (value === 'on') return 'on'
  return 'off'
}

/** The one tag the boot document carries while thread sync is on (and only then). */
export const THREAD_SYNC_META_TAG = '<meta name="aukora-thread-sync" content="on">'

/** Whether thread sync is switched on: the mode is exactly `on`. Every other value, `pull` included, is off. */
export const threadSyncOn = env => threadSyncMode(env) === 'on'

/**
 * The boot document the Worker serves (`/`, `/index.html` and `/preview.html` are all asked as `/preview.html`). Review
 * SHOULD 2: `/preview` too, because the assets binding's default `html_handling` may answer `/preview.html` with a
 * redirect to `/preview` (passed through untouched), and the document the browser then loads must still carry the meta.
 */
const BOOT_DOCUMENTS = Object.freeze(['/preview.html', '/preview'])
/** Only an HTML answer is ever rewritten. */
const HTML_TYPE = /^text\/html(?:\s*;|$)/i
/** The first `<head>` tag (its attributes, if any, kept). */
const HEAD_TAG = /<head(?:\s[^>]*)?>/i

/**
 * The boot document's body, with the switch added only while thread sync is on. With the mode anything
 * but exactly `on`, a request that is not a GET of the boot document, or an answer that is not a 200 `text/html`: the asset's own
 * body object, untouched (byte for byte main). While on: the document's text with `THREAD_SYNC_META_TAG` right after
 * its first `<head>` tag (a document with no `<head>` is served unchanged), and `content-length` and `etag` dropped from
 * `headers` because the bytes changed. Reads env only; no storage, no network.
 * @param {Response} result - The asset's answer.
 * @param {Headers} headers - The headers the Worker will send (changed only when the body is).
 * @param {unknown} env
 * @param {string} method
 * @param {string} pathname - The asset path asked (after `/` and `/index.html` became `/preview.html`).
 * @returns {Promise<ReadableStream | string | null>}
 */
export async function threadSyncDocument(result, headers, env, method, pathname) {
  if (!threadSyncOn(env) || method !== 'GET' || !BOOT_DOCUMENTS.includes(pathname) || result.status !== 200 || result.body === null) return result.body
  if (!HTML_TYPE.test(result.headers.get('content-type') ?? '')) return result.body
  const text = await result.text()
  const head = HEAD_TAG.exec(text)
  if (head === null) return text
  headers.delete('content-length')
  headers.delete('etag')
  const at = head.index + head[0].length
  return `${text.slice(0, at)}${THREAD_SYNC_META_TAG}${text.slice(at)}`
}
