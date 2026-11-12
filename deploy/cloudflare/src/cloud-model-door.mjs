/**
 * THE CLOUD MODEL DOOR: one bounded, non-streaming model call made FROM THE EDGE, so
 * Auma can think through Anthropic, OpenRouter, DeepSeek or OpenAI with every tab closed (the cloud wake).
 *
 * Keys exist only as Worker secrets read from `env` at call time. They are never returned, logged, echoed in an error
 * or written into a request body; a missing secret is refused by code (`PROVIDER_SECRET_NOT_CONFIGURED`) before any
 * network call. Callers speak ONE shape (OpenAI chat: `messages`, function `tools`, `tool_calls`); the door translates
 * to and from the Anthropic Messages API, refuses an Anthropic output cap too small for its always-on thinking, and keeps Anthropic's own content blocks on the reply so a later round can
 * send them back unchanged (thinking blocks included). Redirects are refused, request and response bytes are capped,
 * and a provider failure after dispatch is `PROVIDER_OUTCOME_UNKNOWN` (never retried here: the call may have billed).
 *
 * Billing note: which provider a caller uses is the caller's explicit choice (`provider`), never a silent default here;
 * `pickCloudModelProvider` only ever chooses among the providers it is handed.
 * @module cloud-model-door
 */

const ANTHROPIC_VERSION = '2023-06-01'

/** Provider wire table: origin, secret name, wire shape, default model (null: the caller or env must name one). */
export const CLOUD_MODEL_PROVIDERS = Object.freeze({
  anthropic: Object.freeze({ url: 'https://api.anthropic.com/v1/messages', secret: 'ANTHROPIC_API_KEY', wire: 'anthropic', modelEnv: 'CLOUD_MODEL_ANTHROPIC', model: 'claude-opus-5-5' }),
  openrouter: Object.freeze({ url: 'https://openrouter.ai/api/v1/chat/completions', secret: 'OPENROUTER_API_KEY', wire: 'openai', modelEnv: 'CLOUD_MODEL_OPENROUTER', model: null }),
  deepseek: Object.freeze({ url: 'https://api.deepseek.com/chat/completions', secret: 'DEEPSEEK_API_KEY', wire: 'openai', modelEnv: 'CLOUD_MODEL_DEEPSEEK', model: 'deepseek-chat' }),
  openai: Object.freeze({ url: 'https://api.openai.com/v1/chat/completions', secret: 'OPENAI_API_KEY', wire: 'openai', modelEnv: 'CLOUD_MODEL_OPENAI', model: 'gpt-4o-mini' }),
})

export const CLOUD_MODEL_DOOR_LIMITS = Object.freeze({
  requestBytes: 64 * 1024, responseBytes: 64 * 1024, timeoutMs: 30000,
  /** Current Claude models always think; a smaller output cap is refused (PROVIDER_OUTPUT_LIMIT_TOO_SMALL), never raised. */
  anthropicMinOutputTokens: 2048, maxOutputTokens: 8192,
})

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const refuse = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra })

/** The secret's value, trimmed, with a pasted "Bearer " removed; '' when absent. Never leaves this module. */
function secretOf(env, name) {
  const raw = env?.[name]
  return typeof raw === 'string' ? raw.trim().replace(/^Bearer\s+/i, '').trim() : ''
}

/**
 * Which providers have a secret configured, by name only (never a value).
 * @param {Record<string, unknown>} env
 * @returns {Record<string, boolean>}
 */
export function cloudModelDoorStatus(env) {
  return Object.fromEntries(Object.entries(CLOUD_MODEL_PROVIDERS).map(([name, spec]) => [name, secretOf(env, spec.secret) !== '']))
}

/**
 * Choose the first provider in `order` that has a secret. Refuses by code; never picks a provider not in `order`.
 * @param {Record<string, unknown>} env
 * @param {readonly string[]} order - the caller's explicit preference.
 * @returns {{ ok: true, provider: string } | { ok: false, code: string, tried?: string[] }}
 */
export function pickCloudModelProvider(env, order) {
  const names = (Array.isArray(order) ? order : []).filter(name => Object.hasOwn(CLOUD_MODEL_PROVIDERS, name))
  if (names.length === 0) return refuse('PROVIDER_UNAVAILABLE')
  const found = names.find(name => secretOf(env, CLOUD_MODEL_PROVIDERS[name].secret) !== '')
  return found ? Object.freeze({ ok: true, provider: found }) : refuse('PROVIDER_SECRET_NOT_CONFIGURED', { tried: names })
}

/** OpenAI-shape function tools -> Anthropic tools. */
function anthropicTools(tools) {
  return tools.map(tool => {
    const fn = record(tool?.function) ? tool.function : tool
    return { name: String(fn.name), ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      input_schema: record(fn.parameters) ? fn.parameters : { type: 'object', properties: {} } }
  })
}

/**
 * OpenAI-shape conversation -> Anthropic `system` + `messages`. Assistant turns that carry the door's own
 * `anthropicContent` are sent back verbatim; consecutive tool results become one user turn of `tool_result` blocks.
 */
export function toAnthropicMessages(messages) {
  const system = []
  const out = []
  const push = (role, blocks) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: [...blocks] })
  }
  for (const message of messages) {
    if (!record(message)) continue
    if (message.role === 'system') { if (typeof message.content === 'string') system.push(message.content); continue }
    if (message.role === 'user') { push('user', [{ type: 'text', text: String(message.content ?? '') }]); continue }
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: String(message.tool_call_id), content: String(message.content ?? '') }])
      continue
    }
    if (message.role === 'assistant') {
      if (Array.isArray(message.anthropicContent)) { push('assistant', message.anthropicContent); continue }
      const blocks = []
      if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        let input = {}
        try { input = JSON.parse(call?.function?.arguments ?? '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: String(call.id), name: String(call?.function?.name), input: record(input) ? input : {} })
      }
      if (blocks.length) push('assistant', blocks)
    }
  }
  return { system: system.join('\n\n'), messages: out }
}

/** Anthropic reply -> the door's OpenAI-shape assistant message (plus the raw blocks for replay). */
function fromAnthropic(data) {
  const blocks = Array.isArray(data?.content) ? data.content : []
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
  const toolCalls = blocks.filter(block => block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
    .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(record(block.input) ? block.input : {}) } }))
  return { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), anthropicContent: blocks }
}

async function boundedText(response, maximum, signal) {
  const reader = response.body?.getReader()
  if (!reader) return ''
  // Every read races the caller's abort, and any failure cancels the stream: a stalled provider never holds the wake.
  let onAbort
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('PROVIDER_CALL_CANCELLED'))
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  void aborted.catch(() => {})
  const chunks = []
  let size = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const part = await Promise.race([reader.read(), aborted])
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) throw Object.assign(new Error('PROVIDER_RESPONSE_TOO_LARGE'), { code: 'PROVIDER_RESPONSE_TOO_LARGE' })
      chunks.push(part.value)
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

/**
 * Build one request WITHOUT its credentials: the exact body that will be sent, so a caller can journal it durably
 * before dispatch. Holds no secret and may be persisted as is. Refuses by code (missing secret included).
 * @param {object} input
 * @param {Record<string, unknown>} input.env - Worker env; read for presence and model names only.
 * @param {string} input.provider - an explicit provider name.
 * @param {string} [input.model] - model id; else `env[modelEnv]`, else the table default.
 * @param {Array<object>} input.messages - OpenAI-shape conversation (system/user/assistant/tool).
 * @param {Array<object>} [input.tools] - OpenAI-shape function tools.
 * @param {'auto'|'none'} [input.toolChoice]
 * @param {number} [input.maxTokens] - output cap; default 2048 for Anthropic, 1024 otherwise.
 * @param {number} [input.temperature] - sent on the OpenAI wire only; current Claude models refuse sampling parameters.
 * @returns {{ ok: true, provider: string, model: string, wire: 'anthropic'|'openai', url: string, endpointPath: string, body: object, bodyText: string }
 *   | { ok: false, code: string, provider?: string }}
 */
export function prepareCloudModelRequest({ env, provider, model, messages, tools = [], toolChoice = 'auto', maxTokens, temperature }) {
  const spec = Object.hasOwn(CLOUD_MODEL_PROVIDERS, provider) ? CLOUD_MODEL_PROVIDERS[provider] : null
  if (!spec) return refuse('PROVIDER_UNAVAILABLE')
  if (!secretOf(env, spec.secret)) return refuse('PROVIDER_SECRET_NOT_CONFIGURED', { provider })
  const chosen = typeof model === 'string' && model ? model : typeof env?.[spec.modelEnv] === 'string' && env[spec.modelEnv].trim() ? env[spec.modelEnv].trim() : spec.model
  if (!chosen) return refuse('PROVIDER_MODEL_NOT_CONFIGURED', { provider })
  if (!MODEL_ID.test(chosen)) return refuse('PROVIDER_MODEL_INVALID', { provider })
  if (!Array.isArray(messages) || messages.length === 0 || !Array.isArray(tools) || !['auto', 'none'].includes(toolChoice)) return refuse('PROVIDER_REQUEST_INVALID', { provider })
  // No cap named: enough for an always-thinking Claude model, 1024 elsewhere.
  const fallbackCap = spec.wire === 'anthropic' ? CLOUD_MODEL_DOOR_LIMITS.anthropicMinOutputTokens : 1024
  const cap = Math.max(1, Math.min(Number.isSafeInteger(maxTokens) ? maxTokens : fallbackCap, CLOUD_MODEL_DOOR_LIMITS.maxOutputTokens))
  let body
  if (spec.wire === 'anthropic') {
    const { system, messages: turns } = toAnthropicMessages(messages)
    if (turns.length === 0 || turns[0].role !== 'user') return refuse('PROVIDER_REQUEST_INVALID', { provider })
    // Current Claude models always think, so a small output cap is spent before any word: refused here, before
    // anything is billed, rather than raised past the caller's (budget-governed) cap.
    if (cap < CLOUD_MODEL_DOOR_LIMITS.anthropicMinOutputTokens) return refuse('PROVIDER_OUTPUT_LIMIT_TOO_SMALL', { provider })
    // No temperature: current Claude models refuse sampling parameters. Thinking stays on (it cannot be turned off).
    body = { model: chosen, max_tokens: cap, messages: turns,
      ...(system ? { system } : {}),
      ...(tools.length ? { tools: anthropicTools(tools), tool_choice: { type: toolChoice } } : {}) }
  } else {
    const plain = messages.map(message => {
      if (!record(message)) return message
      const { anthropicContent: _replay, ...rest } = message
      return rest
    })
    body = { model: chosen, stream: false, max_tokens: cap, ...(typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {}),
      messages: plain, ...(tools.length ? { tools, tool_choice: toolChoice } : {}) }
  }
  const bodyText = JSON.stringify(body)
  if (new TextEncoder().encode(bodyText).length > CLOUD_MODEL_DOOR_LIMITS.requestBytes) return refuse('PROVIDER_REQUEST_TOO_LARGE', { provider })
  return Object.freeze({ ok: true, provider, model: chosen, wire: spec.wire, url: spec.url, endpointPath: new URL(spec.url).pathname.replace(/^\/api/, ''), body, bodyText })
}

/**
 * Send one prepared request. The key is read from `env` here, at the last moment, and only into a header.
 * @param {ReturnType<typeof prepareCloudModelRequest>} prepared
 * @param {{ env: Record<string, unknown>, signal?: AbortSignal, fetchImpl?: typeof fetch }} context
 * @returns {Promise<{ ok: true, provider: string, model: string, message: object, stopReason: string | null, usage: object | null }
 *   | { ok: false, code: string, provider?: string, status?: number }>}
 */
export async function sendCloudModelRequest(prepared, { env, signal, fetchImpl = globalThis.fetch } = {}) {
  if (prepared?.ok !== true) return refuse(typeof prepared?.code === 'string' ? prepared.code : 'PROVIDER_REQUEST_INVALID')
  const { provider, wire } = prepared
  const spec = CLOUD_MODEL_PROVIDERS[provider]
  const key = spec ? secretOf(env, spec.secret) : ''
  if (!key) return refuse('PROVIDER_SECRET_NOT_CONFIGURED', { provider })
  const headers = { 'content-type': 'application/json' }
  if (wire === 'anthropic') {
    // An OAuth subscription token goes on Authorization with its beta, as provider-dispatch.mjs does for /door.
    if (key.startsWith('sk-ant-oat')) { headers.authorization = `Bearer ${key}`; headers['anthropic-beta'] = 'oauth-2025-04-20' }
    else headers['x-api-key'] = key
    headers['anthropic-version'] = ANTHROPIC_VERSION
  } else headers.authorization = `Bearer ${key}`

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new Error('PROVIDER_TIMEOUT')), CLOUD_MODEL_DOOR_LIMITS.timeoutMs)
  let dispatched = false
  try {
    controller.signal.throwIfAborted()
    dispatched = true
    const response = await fetchImpl(prepared.url, { method: 'POST', headers, body: prepared.bodyText, redirect: 'manual', signal: controller.signal })
    // A transport that answers after the caller stopped must not keep a body open or be read.
    if (controller.signal.aborted) { void response?.body?.cancel().catch(() => {}); controller.signal.throwIfAborted() }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {})
      return refuse('PROVIDER_REDIRECT_REFUSED', { provider, status: response.status })
    }
    const text = await boundedText(response, CLOUD_MODEL_DOOR_LIMITS.responseBytes, controller.signal)
    // The provider's error body is never echoed: it can quote request content. Only the status travels.
    if (!response.ok) return refuse(response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH_REFUSED' : response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR', { provider, status: response.status })
    let data
    try { data = JSON.parse(text) } catch { return refuse('PROVIDER_RESPONSE_INVALID', { provider }) }
    if (wire === 'anthropic') {
      const stopReason = typeof data?.stop_reason === 'string' ? data.stop_reason : null
      if (stopReason === 'refusal') return refuse('PROVIDER_REFUSED', { provider })
      const message = fromAnthropic(data)
      if (!message.content && !message.tool_calls) return refuse(stopReason === 'max_tokens' ? 'PROVIDER_OUTPUT_TRUNCATED' : 'PROVIDER_RESPONSE_EMPTY', { provider })
      return Object.freeze({ ok: true, provider, model: prepared.model, message, stopReason, usage: record(data.usage) ? data.usage : null })
    }
    const answer = data?.choices?.[0]?.message
    if (!record(answer) || !(answer.content === null || answer.content === undefined || typeof answer.content === 'string')) return refuse('PROVIDER_RESPONSE_INVALID', { provider })
    const message = { role: 'assistant', content: answer.content ?? null, ...(Array.isArray(answer.tool_calls) && answer.tool_calls.length ? { tool_calls: answer.tool_calls } : {}) }
    return Object.freeze({ ok: true, provider, model: prepared.model, message,
      stopReason: typeof data.choices[0].finish_reason === 'string' ? data.choices[0].finish_reason : null, usage: record(data.usage) ? data.usage : null })
  } catch (error) {
    if (signal?.aborted) return refuse('PROVIDER_CALL_CANCELLED', { provider })
    if (error?.code === 'PROVIDER_RESPONSE_TOO_LARGE') return refuse('PROVIDER_RESPONSE_TOO_LARGE', { provider })
    return refuse(dispatched ? 'PROVIDER_OUTCOME_UNKNOWN' : 'PROVIDER_DISPATCH_UNAVAILABLE', { provider })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * One bounded model call through the edge: prepare, then send.
 * @param {Parameters<typeof prepareCloudModelRequest>[0] & { signal?: AbortSignal, fetchImpl?: typeof fetch }} input
 */
export async function callCloudModel({ signal, fetchImpl, ...input }) {
  const prepared = prepareCloudModelRequest(input)
  if (!prepared.ok) return prepared
  return await sendCloudModelRequest(prepared, { env: input.env, signal, ...(fetchImpl ? { fetchImpl } : {}) })
}
