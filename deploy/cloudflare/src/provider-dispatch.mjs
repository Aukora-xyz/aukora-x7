/** HeadDO-owned provider transport. Controllers remain live until stream EOF or cancellation. */
import { claimTurnJournalDispatch } from './turn-journal.mjs'

const PROVIDERS = {
  deepseek: ['https://api.deepseek.com', 'DEEPSEEK_API_KEY'],
  moonshot: ['https://api.moonshot.ai', 'MOONSHOT_API_KEY'],
  'moonshot-cn': ['https://api.moonshot.cn', 'MOONSHOT_CN_API_KEY'],
  openrouter: ['https://openrouter.ai/api', 'OPENROUTER_API_KEY'],
  openai: ['https://api.openai.com', 'OPENAI_API_KEY'],
  anthropic: ['https://api.anthropic.com', 'ANTHROPIC_API_KEY'],
  xai: ['https://api.x.ai', 'XAI_API_KEY'],
}
const MAX_BODY = 16 * 1024 * 1024
const error = (code, status = 409) => Object.assign(new Error(code), { code, status })
const failure = (code, status) => Response.json({ ok: false, code, ...(code === 'PROVIDER_OUTCOME_UNKNOWN'
  ? { outcome: 'unknown', retry: 'do-not-repeat-automatically', error: { type: 'provider_outcome_unknown', code: 'PROVIDER_OUTCOME_UNKNOWN', message: 'The provider may have processed this request. Its result is unknown. Do not automatically resubmit it.' } } : {}) }, { status, headers: { 'cache-control': 'no-store', 'x-should-retry': 'false' } })

/** Create one dispatcher per HeadDO instance, never per request.
 * @param {object} options Trusted storage, deployment secrets and optional fixture-only transport.
 * @returns {object} Dispatch and synchronous turn cancellation operations.
 */
export function createProviderDispatcher({ storage, env, networkFetch = fetch }) {
  const controllers = new Map()
  const parentControllers = new Map()
  return {
    cancel(turnId) {
      const pending = new Set(parentControllers.get(turnId) ?? [])
      const requestController = controllers.get(turnId)
      if (requestController) pending.add(requestController)
      for (const controller of pending) controller.abort(error('TURN_CANCELLED'))
    },
    async dispatch(request) {
      const provider = request.headers.get('x-x6-provider')
      const endpoint = request.headers.get('x-x6-provider-endpoint')
      const target = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null
      if (!target) return failure('PROVIDER_UNAVAILABLE', 404)
      if (!/^\/(?:(?:anthropic\/)?v1\/)?(?:models|chat\/completions|messages|responses)$/.test(endpoint ?? '')
        || (endpoint.endsWith('/models') ? request.method !== 'GET' : request.method !== 'POST')) return failure('PROVIDER_ENDPOINT_UNAVAILABLE', 404)
      const turnId = request.headers.get('x-x6-turn-id')
      const parentTurnId = request.headers.get('x-x6-parent-turn-id')
      if (request.method === 'POST' && !/^[A-Za-z0-9._:-]{1,128}$/.test(turnId ?? '')) return failure('TURN_JOURNAL_ID_INVALID', 400)
      if (parentTurnId !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(parentTurnId)) return failure('TURN_JOURNAL_PARENT_ID_INVALID', 400)
      if (turnId && controllers.has(turnId)) return failure('TURN_DISPATCH_ALREADY_STARTED', 409)
      const controller = new AbortController()
      // Registration precedes the first await, including body reads and durable checks.
      if (turnId) controllers.set(turnId, controller)
      if (parentTurnId) {
        if (!parentControllers.has(parentTurnId)) parentControllers.set(parentTurnId, new Set())
        parentControllers.get(parentTurnId).add(controller)
      }
      let reader = null
      let streamController = null
      let bodyTimer = null
      let retained = false
      let dispatched = false
      let rejectAbort
      const aborted = new Promise((_resolve, reject) => { rejectAbort = reject })
      // The signal can fire between awaits while the streaming response is idle.
      void aborted.catch(_error => {})
      const cleanup = () => {
        clearTimeout(bodyTimer)
        request.signal.removeEventListener('abort', clientAbort)
        controller.signal.removeEventListener('abort', abort)
        if (turnId && controllers.get(turnId) === controller) controllers.delete(turnId)
        if (parentTurnId) {
          const pending = parentControllers.get(parentTurnId)
          pending?.delete(controller)
          if (pending?.size === 0) parentControllers.delete(parentTurnId)
        }
      }
      const abort = () => {
        const reason = controller.signal.reason ?? error('TURN_CANCELLED')
        rejectAbort(reason)
        void reader?.cancel(reason).catch(_error => {})
        if (streamController) { const target = streamController; streamController = null; target.error(reason); cleanup() }
      }
      const clientAbort = () => controller.abort(error('TURN_CANCELLED'))
      controller.signal.addEventListener('abort', abort, { once: true })
      request.signal.addEventListener('abort', clientAbort, { once: true })
      if (request.signal.aborted) clientAbort()
      const check = () => { if (controller.signal.aborted) throw controller.signal.reason }
      try {
        check()
        const key = typeof env[target[1]] === 'string' ? env[target[1]].trim().replace(/^Bearer\s+/i, '').trim() : ''
        if (!key) throw error('PROVIDER_SECRET_NOT_CONFIGURED', 503)
        const headers = new Headers({ 'content-type': 'application/json' })
        const anthropic = provider === 'anthropic' || endpoint.startsWith('/anthropic/')
        if (provider === 'anthropic' && !key.startsWith('sk-ant-oat')) headers.set('x-api-key', key)
        else headers.set('authorization', `Bearer ${key}`)
        if (anthropic) {
          headers.set('anthropic-version', '2023-06-01')
          if (provider !== 'anthropic') headers.set('x-api-key', key)
          if (provider === 'anthropic' && key.startsWith('sk-ant-oat')) headers.set('anthropic-beta', 'oauth-2025-04-20')
          const beta = request.headers.get('anthropic-beta')
          if (beta && /^[A-Za-z0-9_,.-]{1,256}$/.test(beta)) headers.set('anthropic-beta', beta)
        }
        let body
        if (request.method === 'POST') {
          bodyTimer = setTimeout(() => controller.abort(error('PROVIDER_BODY_TIMEOUT', 408)), 30000)
          reader = request.body?.getReader()
          if (!reader) throw error('TURN_JOURNAL_BODY_REQUIRED', 400)
          const chunks = []
          let size = 0
          while (true) {
            const part = await Promise.race([reader.read(), aborted])
            check()
            if (part.done) break
            size += part.value.byteLength
            if (size > MAX_BODY) { void reader.cancel().catch(_error => {}); throw error('REQUEST_BODY_TOO_LARGE', 413) }
            chunks.push(part.value)
          }
          reader.releaseLock()
          reader = null
          clearTimeout(bodyTimer)
          body = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(byte => byte.toString(16).padStart(2, '0')).join('')
          check()
          await claimTurnJournalDispatch(storage, { turnId, parentTurnId, provider, endpoint, requestSha256: hash }, check)
          check()
        }
        dispatched = true
        const pending = Promise.resolve(networkFetch(target[0] + endpoint, { method: request.method, headers, body, redirect: 'manual', signal: controller.signal }))
        // Even transports that resolve after abort must not retain or expose a late response.
        void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(_error => {}) }, _error => {})
        const upstream = await Promise.race([pending, aborted])
        check()
        if (upstream.redirected || (upstream.status >= 300 && upstream.status < 400)) {
          void upstream.body?.cancel().catch(_error => {})
          return failure('PROVIDER_REDIRECT_REFUSED', 502)
        }
        if (!upstream.body) return upstream
        reader = upstream.body.getReader()
        const stream = new ReadableStream({
          start(value) { streamController = value },
          async pull(value) {
            try {
              check()
              const part = await Promise.race([reader.read(), aborted])
              check()
              if (part.done) { streamController = null; value.close(); cleanup(); reader.releaseLock(); reader = null }
              else value.enqueue(part.value)
            } catch (cause) {
              if (streamController) { streamController = null; value.error(cause) }
              void reader?.cancel(cause).catch(_error => {})
              cleanup()
            }
          },
          cancel(reason) { streamController = null; controller.abort(error('TURN_CANCELLED')); void reader?.cancel(reason).catch(_error => {}); cleanup() },
        })
        retained = true
        return new Response(stream, { status: upstream.status, headers: upstream.headers })
      } catch (cause) {
        if (controller.signal.aborted) return failure(cause?.code ?? 'TURN_CANCELLED', cause?.status ?? 409)
        if (dispatched) return failure('PROVIDER_OUTCOME_UNKNOWN', 422)
        return failure(cause?.code ?? 'PROVIDER_DISPATCH_UNAVAILABLE', cause?.status ?? 503)
      } finally {
        if (!retained) { void reader?.cancel().catch(_error => {}); cleanup() }
      }
    },
  }
}
