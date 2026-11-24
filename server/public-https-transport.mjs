/** Node-only public HTTPS transport. No Worker adapter is installed by this module. */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { CLOUD_BROKER_LIMITS, publicHttpsTarget } from '../deploy/cloudflare/src/cloud-brokers.mjs'

const failure = (code, status = 502) => Object.assign(new Error(code), { code, status })
const refusedSubnets = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
])

/** Create a non-rebinding transport for server injection, with no ambient proxy or credentials.
 * IPv4-only: every returned A record must be public; IPv6-only hosts fail closed.
 * The selected address becomes the socket hostname, while TLS SNI, certificate identity
 * and HTTP Host retain the original hostname. No second DNS lookup or redirects occur.
 * https.request TLS options: https://nodejs.org/api/https.html#httpsrequestoptions-callback
 * @param {object} options Trusted DNS/request/monotonic-clock implementations for offline tests, and a deadline no larger than 10 seconds.
 * @returns {Function} GET-only fetch-shaped function returning a buffered Response of at most 256 KiB.
 */
export function createPublicHttpsTransport({ lookup = dnsLookup, request = httpsRequest, now = () => performance.now(), timeoutMs = CLOUD_BROKER_LIMITS.timeoutMs } = {}) {
  if (typeof lookup !== 'function' || typeof request !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CLOUD_BROKER_LIMITS.timeoutMs) throw new TypeError('WEB_EYES_TRANSPORT_CONFIGURATION_INVALID')
  const refused = new BlockList()
  for (const [address, prefix] of refusedSubnets) refused.addSubnet(address, prefix, 'ipv4')
  return async (value, init = {}) => {
    const deadline = now() + timeoutMs
    const target = publicHttpsTarget(value)
    if ((init.method !== undefined && init.method !== 'GET') || (init.redirect !== undefined && init.redirect !== 'manual')) throw failure('WEB_EYES_REQUEST_INVALID', 400)
    const signal = init.signal
    let req, incoming, timer, settled = false, onAbort
    return new Promise((resolve, reject) => {
      const finish = (error, response) => {
        if (settled) return
        if (!error && now() >= deadline) error = failure('WEB_EYES_TIMEOUT', 408)
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) { incoming?.destroy(); req?.destroy(); reject(error) }
        else resolve(response)
      }
      onAbort = () => finish(failure('WEB_EYES_TIMEOUT', 408))
      const expired = () => {
        if (settled) return true
        if (now() < deadline) return false
        onAbort()
        return true
      }
      timer = setTimeout(onAbort, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); return }
      // lookup cannot be cancelled. Its late result is discarded before opening a socket.
      Promise.resolve().then(() => {
        if (expired()) return
        return lookup(target.hostname, { all: true, family: 4, verbatim: true })
      }).then(addresses => {
        if (expired()) return
        if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 32
          || addresses.some(entry => entry?.family !== 4 || isIP(entry.address) !== 4 || refused.check(entry.address, 'ipv4'))) {
          finish(failure('WEB_EYES_ADDRESS_REFUSED', 403)); return
        }
        const selected = addresses[0].address
        if (expired()) return
        req = request({ protocol: 'https:', hostname: selected, family: 4, port: 443,
          servername: target.hostname, rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(target.hostname, certificate),
          lookup: (_hostname, _options, callback) => callback(failure('WEB_EYES_SECOND_LOOKUP_REFUSED', 403)),
          agent: false, method: 'GET', path: target.pathname + target.search,
          headers: { host: target.hostname, accept: 'text/html, text/plain, application/json, application/xhtml+xml', 'accept-encoding': 'identity', connection: 'close' },
          maxHeaderSize: 16384,
        }, response => {
          incoming = response
          if (expired()) { response.destroy(); return }
          const status = response.statusCode, headers = response.headers
          if (status >= 300 && status < 400) { finish(failure('WEB_EYES_REDIRECT_REFUSED')); return }
          if (!Number.isInteger(status) || status < 200 || status >= 300) { finish(failure('WEB_EYES_UPSTREAM_FAILED')); return }
          const declared = headers['content-length']
          if (declared !== undefined && (typeof declared !== 'string' || !/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared)))) { finish(failure('WEB_EYES_BODY_INVALID')); return }
          if (Number(declared) > CLOUD_BROKER_LIMITS.responseBytes) { finish(failure('WEB_EYES_BODY_TOO_LARGE', 413)); return }
          const chunks = []; let bytes = 0
          response.on('data', chunk => {
            if (expired()) return
            bytes += chunk.byteLength
            if (bytes > CLOUD_BROKER_LIMITS.responseBytes) { finish(failure('WEB_EYES_BODY_TOO_LARGE', 413)); return }
            chunks.push(chunk)
          })
          response.once('error', () => finish(failure('WEB_EYES_UPSTREAM_FAILED')))
          response.once('aborted', () => finish(failure('WEB_EYES_UPSTREAM_FAILED')))
          response.once('end', () => {
            if (expired()) return
            if (declared !== undefined && Number(declared) !== bytes) { finish(failure('WEB_EYES_BODY_INVALID')); return }
            const projected = {}
            for (const key of ['content-type', 'content-encoding']) if (typeof headers[key] === 'string') projected[key] = headers[key]
            try { finish(null, new Response(status === 204 || status === 205 ? null : Buffer.concat(chunks, bytes), { status, headers: projected })) }
            catch (_error) { finish(failure('WEB_EYES_UPSTREAM_FAILED')) }
          })
        })
        req.once('error', () => finish(failure('WEB_EYES_UPSTREAM_FAILED')))
        req.end()
      }).catch(() => finish(failure('WEB_EYES_UPSTREAM_FAILED')))
    })
  }
}
