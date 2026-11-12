/** Ephemeral response-readiness metadata only. Never inspect headers, payloads or response bodies. */
export const EDGE_DIAGNOSTIC_LIMITS = Object.freeze({ events: 100, bytes: 32 * 1024, durationMs: 86400000 })
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'])
const SCOPES = new Set(['worker-isolate', 'head-object-instance', 'mirror-object-instance'])
const ROUTES = new Set([
  '/:other', '/:asset', '/door/:provider', '/_auth/owner', '/_bootstrap', '/api/health',
  '/_host/repo', '/_host/github', '/_host/cloudflare', '/_host/selftest', '/_host/diagnostics', '/_host/web-eyes',
  '/_host/wake', '/_host/owner-key', '/_host/owner-grant', '/_host/governance/verify', '/_host/checkpoint-policy',
  '/_host/aumlok/status', '/_host/aumlok/challenge', '/_host/aumlok/bind', '/_host/aumlok/refresh',
  '/_host/aumlok/invite', '/_host/aumlok/approve', '/_host/aumlok/unseal',
  '/_head/ball', '/_head/lease', '/_head/status', '/_head/ws', '/_head/bootstrap', '/_head/bootstrap-status',
  '/_head/provider-budget', '/_head/class3-authorize', '/_head/mirror-updated', '/_head/state-diff', '/_head/diagnostics',
  '/_mirror/delta', '/_mirror/status', '/_mirror/memory-history', '/_mirror/conflicts', '/_mirror/export',
  '/_mirror/repo-read', '/_mirror/prediction-status', '/_mirror/aura-inputs', '/_mirror/bootstrap', '/_mirror/bootstrap-status', '/_mirror/diagnostics',
  '/api/snapshot', '/__x6/status', '/api/x61/status', '/__x6/facts', '/api/x61/facts',
  '/aukora-messages/contacts.json', '/aukora-messages/thread', '/aukora-messages/send', '/aukora-messages/add-contact',
])
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum
const time = value => integer(value, 8640000000000000)
const statusCode = status => `HTTP_${status}`
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length

function route(url) {
  const path = new URL(url).pathname
  if (ROUTES.has(path)) return path
  if (['/', '/index.html', '/preview.html', '/favicon.ico'].includes(path)
    || path.startsWith('/preview/') || path.startsWith('/cells/')
    || path.startsWith('/assets/') || path.startsWith('/_runtime/')) return '/:asset'
  if (path.startsWith('/door/')) return '/door/:provider'
  return '/:other'
}

function eventView(value) {
  if (!value || !time(value.at) || !METHODS.has(value.method) || !ROUTES.has(value.pathname)
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || value.code !== statusCode(value.status) || !integer(value.durationMs, EDGE_DIAGNOSTIC_LIMITS.durationMs)) throw new Error('DIAGNOSTICS_INVALID')
  return { at: value.at, method: value.method, pathname: value.pathname, status: value.status, code: value.code, durationMs: value.durationMs }
}

/** Validate and project an untrusted DO snapshot without carrying extra fields.
 * @param {object} value Snapshot from the internal binding.
 * @param {string} scope Expected fixed execution scope.
 * @returns {object} Bounded copied metadata, or throws for invalid input.
 */
export function projectDiagnostics(value, scope) {
  if (!SCOPES.has(scope) || value?.schema !== 'x61-edge-diagnostics/v1' || value.scope !== scope
    || value.ephemeral !== true || value.durableAudit !== false || value.browserNetwork !== false
    || value.limit !== EDGE_DIAGNOSTIC_LIMITS.events || !Array.isArray(value.events)
    || value.events.length > EDGE_DIAGNOSTIC_LIMITS.events) throw new Error('DIAGNOSTICS_INVALID')
  const result = { schema: value.schema, scope, ephemeral: true, durableAudit: false, browserNetwork: false,
    limit: EDGE_DIAGNOSTIC_LIMITS.events, events: value.events.map(eventView) }
  if (bytes(result) > EDGE_DIAGNOSTIC_LIMITS.bytes) throw new Error('DIAGNOSTICS_INVALID')
  return result
}

/** Create one bounded ring per Worker or DO instance; eviction/restart loses history.
 * @param {string} scope Fixed scope, never an identity or request field.
 * @param {Function} now Millisecond clock; invalid readings become zero.
 * @returns {object} Response-readiness observer and copied snapshot reader. Stream completion, later failures and WebSocket traffic are not observed; duration includes any handler queue wait.
 */
export function createEdgeDiagnostics(scope, now = Date.now) {
  if (!SCOPES.has(scope)) throw new Error('DIAGNOSTICS_SCOPE_INVALID')
  const events = []
  const clock = () => { const value = now(); return time(value) ? value : 0 }
  return {
    snapshot: () => projectDiagnostics({ schema: 'x61-edge-diagnostics/v1', scope, ephemeral: true, durableAudit: false,
      browserNetwork: false, limit: EDGE_DIAGNOSTIC_LIMITS.events, events }, scope),
    async observe(request, operation) {
      // Reduce request metadata before awaiting. Retain no URL, body, header or arbitrary method string.
      const at = clock(), method = METHODS.has(request.method) ? request.method : 'OTHER', pathname = route(request.url)
      let status = 500
      try { const response = await operation(); status = response.status; return response }
      finally {
        if (!Number.isInteger(status) || status < 100 || status > 599) status = 500
        const durationMs = Math.min(EDGE_DIAGNOSTIC_LIMITS.durationMs, Math.max(0, clock() - at))
        events.push(eventView({ at, method, pathname, status, code: statusCode(status), durationMs }))
        if (events.length > EDGE_DIAGNOSTIC_LIMITS.events) events.shift()
      }
    },
  }
}
