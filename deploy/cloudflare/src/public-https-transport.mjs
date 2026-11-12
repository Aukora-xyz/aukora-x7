/** Bounded anonymous HTTPS reads with separate public-platform and fixed-origin policies.
 * General reads rely on Cloudflare production's post-DNS public-address enforcement,
 * not application IP pinning. Local Miniflare outbound networking is not that guarantee.
 * https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public
 * https://github.com/cloudflare/cloudflare-os/tree/main/packages/gatekeeper-mcp
 */
import { CLOUD_BROKER_LIMITS, publicHttpsTarget } from './cloud-brokers.mjs'

/** Exact provider origins; neither callers nor environment variables can expand them. */
export const TRUSTED_DOCS_HTTPS_ORIGINS = Object.freeze([
  'https://api.github.com',
  'https://developers.cloudflare.com',
  'https://developer.mozilla.org',
  'https://registry.npmjs.org',
])

class TransportFailure extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status }
}
const failure = (code, status) => new TransportFailure(code, status)
const fail = (code, status) => { throw failure(code, status) }
const cancel = source => { if (source) void source.cancel().catch(_error => {}) }

/** Inspect actual runtime flags, never request data or ordinary environment booleans.
 * @returns {boolean} Whether production global fetch has public routing and default external TLS trust enabled.
 */
export function platformPublicHttpsAvailable() {
  const flags = globalThis.Cloudflare?.compatibilityFlags
  return flags?.global_fetch_strictly_public === true && flags?.no_cots_on_external_fetch === true
}

function publicTarget(value, ownHostname) {
  if (!platformPublicHttpsAvailable()) fail('PUBLIC_NETWORK_GUARD_UNAVAILABLE', 503)
  const target = publicHttpsTarget(value)
  if ((target.href !== value && target.href !== value + '/') || target.href.includes('#') || target.hostname === ownHostname) fail('WEB_EYES_URL_REFUSED', 403)
  return target
}

/** Create production-platform-enforced public GET reads, or null when flags are absent.
 * Only real global fetch is captured; caller fetch functions and private bindings cannot inherit this guarantee.
 * The broker must screen URLs and complete decoded responses for secrets. No credentials or redirects are forwarded.
 * Local development must use synthetic egress; its network is not production public-address enforcement.
 * @param {object} options Public host and optional tighter timeout/clock, never a network function or permission flag.
 * @returns {Function|null} Bounded anonymous UTF-8 transport marked with its platform network policy, or null.
 */
export function createPlatformPublicHttpsTransport(options = {}) {
  if (!platformPublicHttpsAvailable()) return null
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['publicHost', 'timeoutMs', 'now'].includes(key))) throw new TypeError('WEB_EYES_TRANSPORT_CONFIGURATION_INVALID')
  const networkFetch = globalThis.fetch.bind(globalThis)
  const transport = createHttpsTransport({ ...options, networkFetch }, publicTarget)
  Object.defineProperty(transport, 'networkPolicy', { value: 'cloudflare-global-fetch-strictly-public' })
  return transport
}

function trustedTarget(value, ownHostname) {
  const target = publicHttpsTarget(value)
  if (target.href !== value || target.href.includes('#') || target.hostname === ownHostname || !TRUSTED_DOCS_HTTPS_ORIGINS.includes(target.origin)) fail('TRUSTED_DOCS_ORIGIN_REFUSED', 403)
  // Only GitHub's numeric pagination is accepted. Documentation and npm metadata
  // reads need no query; arbitrary search text, auth parameters and aliases refuse.
  if (target.href.includes('?')) {
    if (target.hostname !== 'api.github.com' || !target.search) fail('TRUSTED_DOCS_QUERY_REFUSED', 403)
    const seen = new Set(), canonical = []
    for (const [key, value] of target.searchParams) {
      const maximum = key === 'page' ? 1000 : key === 'per_page' ? 100 : 0
      if (!maximum || seen.has(key) || !/^[1-9][0-9]*$/.test(value) || Number(value) > maximum) fail('TRUSTED_DOCS_QUERY_REFUSED', 403)
      seen.add(key); canonical.push(`${key}=${value}`)
    }
    if (target.search !== '?' + canonical.join('&')) fail('TRUSTED_DOCS_QUERY_REFUSED', 403)
  }
  return target
}

/** Create an anonymous GET transport for four fixed documentation/API providers.
 * The caller must screen raw, decoded and canonical URLs for configured secrets before
 * dispatch and scrub returned content. Paths are caller-selected; only numeric GitHub
 * pagination queries are allowed. Response headers and caller headers are not forwarded.
 * No DNS preflight, unsupported TLS override, redirect, retry or ambient fetch fallback.
 * @param {object} options Required trusted platform networkFetch and PUBLIC_HOST hostname. Optional timeoutMs tightens the 10-second ceiling; now defaults to performance.now and is injectable for synthetic deadline tests.
 * @returns {Function} GET-only fetch-shaped function buffering complete, valid UTF-8 text up to 256 KiB. An omitted signal uses the internal deadline; a supplied signal additionally cancels the operation. Failures abort fetch and cancel any received body, including late responses.
 */
export function createTrustedDocsHttpsTransport(options = {}) {
  return createHttpsTransport(options, trustedTarget)
}

function createHttpsTransport({ networkFetch, publicHost, timeoutMs = CLOUD_BROKER_LIMITS.timeoutMs, now = () => performance.now() } = {}, selectTarget) {
  if (typeof networkFetch !== 'function' || typeof now !== 'function' || typeof publicHost !== 'string'
    || !/^[a-z0-9.-]+$/.test(publicHost) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLOUD_BROKER_LIMITS.timeoutMs) throw new TypeError('TRUSTED_DOCS_TRANSPORT_CONFIGURATION_INVALID')
  // The application's hostname is a refusal identity, not an outbound destination.
  // Private or reserved names remain valid here for isolated installations/tests.
  const ownHostname = publicHost.replace(/\.$/, '')
  if (ownHostname.length > 253 || ownHostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new TypeError('TRUSTED_DOCS_TRANSPORT_CONFIGURATION_INVALID')
  return async (value, init = {}) => {
    const target = selectTarget(value, ownHostname)
    if (init === null || typeof init !== 'object' || Array.isArray(init)
      || Object.keys(init).some(key => !['method', 'redirect', 'credentials', 'signal', 'headers'].includes(key))
      || (init.method !== undefined && init.method !== 'GET')
      || (init.redirect !== undefined && init.redirect !== 'manual')
      || (init.credentials !== undefined && init.credentials !== 'omit')) fail('WEB_EYES_REQUEST_INVALID', 400)
    const signal = init.signal
    if (signal !== undefined && (signal === null || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('WEB_EYES_REQUEST_INVALID', 400)
    const controller = new AbortController(), deadline = now() + timeoutMs
    let settled = false, upstream, reader, timer, onAbort
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (settled) return
        if (!error && now() >= deadline) error = failure('WEB_EYES_TIMEOUT', 408)
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          controller.abort()
          cancel(reader || upstream?.body)
          reject(error)
        } else resolve(result)
      }
      onAbort = () => finish(failure('WEB_EYES_TIMEOUT', 408))
      const active = () => {
        if (settled) return false
        if (now() < deadline) return true
        onAbort(); return false
      }
      timer = setTimeout(onAbort, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      Promise.resolve().then(() => {
        if (!active()) return
        return networkFetch(target.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
          cache: 'no-store', referrerPolicy: 'no-referrer', referrer: '',
          headers: { accept: 'text/html, text/plain, application/json, application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'your-node-trusted-docs' },
        })
      }).then(async response => {
        if (!active()) { cancel(response?.body); return }
        if (!(response instanceof Response)) fail('WEB_EYES_UPSTREAM_FAILED')
        upstream = response
        if (response.redirected || (response.status >= 300 && response.status < 400)
          || (response.url && response.url !== target.href)) fail('WEB_EYES_REDIRECT_REFUSED')
        if (!response.ok) fail('WEB_EYES_UPSTREAM_FAILED')
        const contentType = response.headers.get('content-type') || ''
        if (contentType.length > 256 || !/^(?:text\/(?:plain|html|markdown|x-markdown)|application\/(?:json|xhtml\+xml))(?:\s*;|$)/i.test(contentType)
          || (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')) fail('WEB_EYES_CONTENT_TYPE_REFUSED')
        const declared = response.headers.get('content-length')
        if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared)))) fail('WEB_EYES_BODY_INVALID')
        if (declared !== null && Number(declared) > CLOUD_BROKER_LIMITS.responseBytes) fail('WEB_EYES_BODY_TOO_LARGE', 413)
        if (!response.body) fail('WEB_EYES_BODY_INVALID')
        reader = response.body.getReader()
        const buffer = new Uint8Array(CLOUD_BROKER_LIMITS.responseBytes); let bytes = 0
        try {
          for (;;) {
            if (!active()) return
            const { done, value } = await reader.read()
            if (!active()) return
            if (done) break
            if (bytes + value.byteLength > CLOUD_BROKER_LIMITS.responseBytes) fail('WEB_EYES_BODY_TOO_LARGE', 413)
            buffer.set(value, bytes)
            bytes += value.byteLength
          }
          if (declared !== null && Number(declared) !== bytes) fail('WEB_EYES_BODY_INVALID')
          const joined = buffer.subarray(0, bytes)
          let text
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(joined) }
          catch (_error) { fail('WEB_EYES_ENCODING_INVALID') }
          if (text.includes('\u0000')) fail('WEB_EYES_ENCODING_INVALID')
          if (!active()) return
          finish(null, new Response(joined, { status: response.status, headers: { 'content-type': contentType, 'content-length': String(bytes), 'cache-control': 'no-store' } }))
        } catch (error) {
          finish(error instanceof TransportFailure ? error : failure('WEB_EYES_UPSTREAM_FAILED'))
        } finally {
          reader.releaseLock()
          reader = undefined
        }
      }).catch(error => finish(error instanceof TransportFailure ? error : failure('WEB_EYES_UPSTREAM_FAILED')))
    })
  }
}
