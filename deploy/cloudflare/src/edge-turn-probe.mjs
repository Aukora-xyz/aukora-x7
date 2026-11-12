/** One opt-in, read-only model classification; not an autonomous task loop. */
import { validateAuraVector } from '../../../server/aura-rules.mjs'

/** Fixed request and response budgets; the wake runner owns the 1..30000ms deadline. */
export const EDGE_TURN_PROBE_LIMITS = Object.freeze({ responseBytes: 4096, maxTokens: 8 })

const endpoint = 'https://edge-probe.internal/v1/chat/completions'
const instruction = 'Classify the supplied attention metrics. Reply with exactly ATTENTION, REST, or UNKNOWN. Do not execute tasks, use tools, create mandates, or change any state.'
const outcome = status => ({ status })

function eligible(context, head, now) {
  try {
    return context?.verification === 'verified' && context.wake?.enabled === true
      && head !== null && validateAuraVector(context.aura)
      && !context.aura.salience.some(item => item.code === 'invalid-signals')
      && context.aura.ballId === head.ballId && context.aura.epoch === head.epoch
      && context.aura.computedAt === now
      && (context.aura.recommendedFocus !== 'rest' || context.aura.vector.wakeUrgency >= 0.2)
  } catch (_error) { return false /* Invalid trusted-adapter data is inert. */ }
}

async function readBounded(response, signal) {
  const reader = response.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', size = 0, ended = false
  try {
    const length = response.headers.get('content-length')
    const encoding = response.headers.get('content-encoding')
    if (!response.ok || response.redirected || (encoding && encoding !== 'identity')
      || (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length)
        || !Number.isSafeInteger(Number(length)) || Number(length) > EDGE_TURN_PROBE_LIMITS.responseBytes))) return null
    for (;;) {
      if (signal.aborted) return null
      const chunk = await reader.read()
      if (chunk.done) { ended = true; break }
      if (signal.aborted) return null
      size += chunk.value.byteLength
      if (size > EDGE_TURN_PROBE_LIMITS.responseBytes) return null
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    if (signal.aborted || (length !== null && Number(length) !== size)) return null
    return JSON.parse(text)
  } finally {
    // Await cancellation: an unresolved transport keeps the runner's durable claim occupied.
    try { if (!ended) await reader.cancel() }
    finally { reader.releaseLock() }
  }
}

/**
 * Install only from trusted owner deployment configuration, never request/model-supplied flags.
 * Disabled (the default) or missing binding/context reader returns undefined, so the existing wake
 * runner reports executor_unavailable. Enabled callers must use createWakeProbeRunner inside
 * createDurableWakeStore: it owns deadlines, abort, single-flight durable claims and settlement.
 * readContext must freshly fence Head and wake configuration and return a current, independently
 * verified aura, not the scorer's fail-safe vector. The helper cannot grant that verification.
 * transport is an owner-provisioned service binding exposing a read-only OpenAI-compatible model
 * endpoint with the fixed model alias edge-attention-probe. It must not execute tools or other
 * effects. No public fetch fallback, credentials, retries, schedules or provisioning occur here.
 * Only focus and urgency leave the process; the model reply is discarded after classification.
 * No HEAD selection, mandates, memory, file contents or communication capabilities are provided.
 * Abort is forwarded unchanged; the returned promise waits for transport/body settlement even
 * after timeout, so an ignored abort cannot release the existing durable claim prematurely.
 * @param {object} options Trusted enabled boolean, optional transport.fetch and readContext callback.
 * @returns {Function|undefined} Existing runWakeProbe callback returning a fixed status only.
 */
export function createEdgeTurnProbe({ enabled = false, transport, readContext } = {}) {
  if (enabled !== true || typeof transport?.fetch !== 'function' || typeof readContext !== 'function') return undefined
  return async ({ head, now, signal }) => {
    if (!(signal instanceof AbortSignal) || signal.aborted) return outcome('blocked')
    try {
      const context = await readContext(Object.freeze({ head, now, signal }))
      if (signal.aborted || !eligible(context, head, now)) return outcome('blocked')
      const request = new Request(endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'edge-attention-probe', stream: false,
          max_tokens: EDGE_TURN_PROBE_LIMITS.maxTokens, temperature: 0,
          messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify({
            recommendedFocus: context.aura.recommendedFocus, wakeUrgency: context.aura.vector.wakeUrgency,
          }) }] }),
      })
      const response = await transport.fetch(request)
      const value = await readBounded(response, signal)
      if (signal.aborted) return outcome('blocked')
      const choice = Array.isArray(value?.choices) && value.choices.length === 1 ? value.choices[0] : null
      const message = choice?.message
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)
        || !message || typeof message !== 'object' || Array.isArray(message)
        || choice.finish_reason !== 'stop' || message.role !== 'assistant'
        || Object.keys(message).some(key => !['role', 'content'].includes(key))
        || !['ATTENTION', 'REST', 'UNKNOWN'].includes(message.content)) return outcome('failed')
      return outcome(message.content === 'UNKNOWN' ? 'blocked' : 'success')
    } catch (_error) {
      // Neither remote errors nor response text may enter receipts or logs.
      return outcome(signal.aborted ? 'blocked' : 'failed')
    }
  }
}
