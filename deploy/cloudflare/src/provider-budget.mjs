/** Durable conservative reservations, not provider billing or exact token metering. */
const PROVIDERS = new Set(['deepseek', 'moonshot', 'moonshot-cn', 'openrouter', 'openai', 'anthropic', 'xai'])
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }) }

/** Validate deployment quotas. Missing or invalid configuration disables provider requests.
 * @param {object} env Deployment configuration, never request input.
 * @returns {object} Fixed-window request and reserved-token limits.
 */
export function providerBudgetLimits(env) {
  const limits = { windowMs: Number(env.PROVIDER_BUDGET_WINDOW_MS), requests: Number(env.PROVIDER_BUDGET_REQUESTS), tokens: Number(env.PROVIDER_BUDGET_TOKENS), maxOutputTokens: Number(env.PROVIDER_MAX_OUTPUT_TOKENS) }
  if (!Object.values(limits).every(Number.isSafeInteger) || limits.windowMs < 60000 || limits.windowMs > 3600000 || limits.requests < 1 || limits.requests > 10000 || limits.tokens < 1 || limits.tokens > 100000000 || limits.maxOutputTokens < 1 || limits.maxOutputTokens > 1000000 || limits.maxOutputTokens > limits.tokens) fail('PROVIDER_BUDGET_UNCONFIGURED', 503)
  return Object.freeze(limits)
}

/** Accept only self-contained text and client function-tool requests whose input allowance can be bounded.
 * Remote files, stored conversations, server tools and unspecified output ceilings
 * are refused rather than assigned a misleading byte-derived token reservation.
 * @param {Uint8Array|undefined} bytes Complete bounded JSON body for a POST, absent for model listing.
 * @param {object} limits Validated deployment limits.
 * @param {string} pathname Provider wire endpoint, without query parameters.
 * @returns {object} Requested model and conservative text-input/output reservation, not a monetary cap.
 */
export function providerRequestReservation(bytes, limits, pathname) {
  if (bytes === undefined) {
    if (typeof pathname !== 'string' || !pathname.endsWith('/models')) fail('PROVIDER_ENDPOINT_UNAVAILABLE', 404)
    return { requestedModel: null, tokens: 0 }
  }
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const only = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key))
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,256}$/.test(value)
  const boundedList = (value, check, limit = 4096) => Array.isArray(value) && value.length > 0 && value.length <= limit && value.every(check)
  const boundedOptionalList = (value, check, limit = 4096) => Array.isArray(value) && value.length <= limit && value.every(check)
  const selfContained = (value, depth = 0) => depth < 64 && (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) ? value.every(child => selfContained(child, depth + 1)) : record(value) && Object.entries(value).every(([key, child]) => (key !== '$ref' || (typeof child === 'string' && child.startsWith('#/'))) && selfContained(child, depth + 1))))
  const wire = pathname.endsWith('/chat/completions') ? 'chat' : pathname.endsWith('/messages') ? 'messages' : pathname.endsWith('/responses') ? 'responses' : null
  if (!wire || bytes.byteLength > 16 * 1024 * 1024) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  let input
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_error) { fail('PROVIDER_BUDGET_REQUEST_INVALID', 400) }
  const outputFields = wire === 'responses' ? ['max_output_tokens'] : wire === 'messages' ? ['max_tokens'] : ['max_tokens', 'max_completion_tokens']
  const fields = new Set(['model', 'temperature', 'top_p', 'stream', 'tools', 'tool_choice', ...outputFields,
    ...(wire === 'chat' ? ['messages', 'stop', 'n', 'parallel_tool_calls'] : wire === 'messages' ? ['messages', 'system', 'stop_sequences', 'thinking', 'output_config', 'metadata', 'top_k'] : ['input', 'instructions', 'parallel_tool_calls', 'store'])])
  if (!record(input) || Object.keys(input).some(key => !fields.has(key))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  if (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,199}$/.test(input.model) || (input.n !== undefined && input.n !== 1)) fail('PROVIDER_BUDGET_REQUEST_INVALID', 400)
  if (input.thinking !== undefined && !(record(input.thinking) && only(input.thinking, ['type', 'budget_tokens']) && ['enabled', 'disabled'].includes(input.thinking.type) && (input.thinking.budget_tokens === undefined || (Number.isSafeInteger(input.thinking.budget_tokens) && input.thinking.budget_tokens >= 1)))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  if (input.output_config !== undefined && !(only(input.output_config, ['effort']) && ['low', 'medium', 'high', 'max'].includes(input.output_config.effort))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  const functionDefinition = (value, anthropic = false) => only(value, anthropic ? ['name', 'description', 'input_schema', 'defer_loading', 'cache_control'] : ['name', 'description', 'parameters', 'strict'])
    && identifier(value.name) && (value.description === undefined || typeof value.description === 'string') && (value.strict === undefined || typeof value.strict === 'boolean')
    && (value.defer_loading === undefined || typeof value.defer_loading === 'boolean')
    && record(anthropic ? value.input_schema : value.parameters) && selfContained(anthropic ? value.input_schema : value.parameters)
  if (input.tools !== undefined && !(Array.isArray(input.tools) && input.tools.length <= 512 && input.tools.every(tool => wire === 'chat'
    ? only(tool, ['type', 'function']) && tool.type === 'function' && functionDefinition(tool.function)
    : wire === 'messages' ? functionDefinition(tool, true)
      : only(tool, ['type', 'name', 'description', 'parameters', 'strict']) && tool.type === 'function' && functionDefinition(Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'type')))))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  if (input.tool_choice !== undefined) {
    const choice = input.tool_choice
    const valid = ['auto', 'none', 'required'].includes(choice) || (wire === 'chat'
      ? only(choice, ['type', 'function']) && choice.type === 'function' && only(choice.function, ['name']) && identifier(choice.function.name)
      : wire === 'responses' ? only(choice, ['type', 'name']) && choice.type === 'function' && identifier(choice.name)
        : only(choice, ['type', 'name', 'disable_parallel_tool_use']) && ['auto', 'any', 'none', 'tool'].includes(choice.type)
          && (choice.type === 'tool' ? identifier(choice.name) : choice.name === undefined) && (choice.disable_parallel_tool_use === undefined || typeof choice.disable_parallel_tool_use === 'boolean'))
    if (!valid) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  }
  const textBlock = block => only(block, ['type', 'text', 'cache_control']) && ['text', 'input_text', 'output_text'].includes(block.type) && typeof block.text === 'string'
  const wireInput = block => textBlock(block) || (only(block, ['type', 'source']) && block.type === 'image' && record(block.source) && only(block.source, ['type', 'media_type', 'data']) && block.source.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string')
  const chatCall = call => only(call, ['id', 'type', 'function']) && identifier(call.id) && call.type === 'function' && only(call.function, ['name', 'arguments']) && identifier(call.function.name) && typeof call.function.arguments === 'string'
  const anthropicBlock = block => wireInput(block)
    || (only(block, ['type', 'thinking', 'signature']) && block.type === 'thinking' && typeof block.thinking === 'string' && (block.signature === undefined || typeof block.signature === 'string'))
    || (only(block, ['type', 'tool']) && ['tool_addition', 'tool_removal'].includes(block.type) && record(block.tool) && only(block.tool, ['type', 'name']) && block.tool.type === 'tool_reference' && identifier(block.tool.name))
    || (only(block, ['type', 'id', 'name', 'input']) && block.type === 'tool_use' && identifier(block.id) && identifier(block.name) && record(block.input) && selfContained(block.input))
    || (only(block, ['type', 'tool_use_id', 'content', 'is_error']) && block.type === 'tool_result' && identifier(block.tool_use_id) && (typeof block.content === 'string' || boundedOptionalList(block.content, wireInput)) && (block.is_error === undefined || typeof block.is_error === 'boolean'))
  const chatMessage = message => only(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'name']) && ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
    && (typeof message.content === 'string' || (message.role === 'assistant' && message.content === null && boundedList(message.tool_calls, chatCall, 64)))
    && (message.tool_calls === undefined || (message.role === 'assistant' && boundedList(message.tool_calls, chatCall, 64)))
    && (message.role === 'tool' ? identifier(message.tool_call_id) : message.tool_call_id === undefined) && (message.name === undefined || identifier(message.name))
  const responseItem = item => (only(item, ['type', 'role', 'content']) && (item.type === undefined || item.type === 'message') && ['system', 'developer', 'user', 'assistant'].includes(item.role) && (typeof item.content === 'string' || boundedList(item.content, textBlock)))
    || (only(item, ['type', 'call_id', 'output']) && item.type === 'function_call_output' && identifier(item.call_id) && typeof item.output === 'string')
    || (only(item, ['type', 'id', 'call_id', 'name', 'arguments']) && item.type === 'function_call' && (item.id === undefined || identifier(item.id)) && identifier(item.call_id) && identifier(item.name) && typeof item.arguments === 'string')
  const contentValid = wire === 'chat' ? boundedList(input.messages, chatMessage)
    : wire === 'messages' ? boundedList(input.messages, message => only(message, ['role', 'content']) && ['user', 'assistant', 'system'].includes(message.role) && (typeof message.content === 'string' || boundedList(message.content, anthropicBlock)))
      : typeof input.input === 'string' || boundedList(input.input, responseItem)
  if (!contentValid || (input.system !== undefined && !(typeof input.system === 'string' || boundedList(input.system, textBlock))) || (input.instructions !== undefined && typeof input.instructions !== 'string')) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  for (const key of ['stop', 'stop_sequences']) if (input[key] !== undefined && !(typeof input[key] === 'string' || (Array.isArray(input[key]) && input[key].length <= 16 && input[key].every(value => typeof value === 'string')))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  for (const key of ['temperature', 'top_p']) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > (key === 'top_p' ? 1 : 2))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  for (const key of ['stream', 'parallel_tool_calls']) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  if (input.store !== undefined && input.store !== false) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  const maxima = outputFields.filter(key => Object.hasOwn(input, key)).map(key => input[key])
  if (maxima.length !== 1 || maxima.some(value => !Number.isSafeInteger(value) || value < 1 || value > limits.maxOutputTokens)) fail('PROVIDER_OUTPUT_LIMIT_REQUIRED', 400)
  // One token per UTF-8 byte plus explicit framing allowance for each message.
  // Pricing and provider-controlled reasoning overhead are not an exact bill cap.
  const messageCount = input.messages?.length ?? (Array.isArray(input.input) ? input.input.length : 1)
  // Forward the validated interpretation, not ambiguous duplicate-key JSON bytes.
  const bodyBytes = new TextEncoder().encode(JSON.stringify(input))
  if (bodyBytes.byteLength > 16 * 1024 * 1024) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  return { requestedModel: input.model, bodyBytes, tokens: Math.max(bytes.byteLength, bodyBytes.byteLength) + 1024 + messageCount * 256 + (input.tools?.length ?? 0) * 256 + maxima[0] }
}

/** Adapt one private atomic JSON record to the shared provider quota store.
 * @param {object} storage Single-record durable storage; owns locks, filesystem security and atomic replacement.
 * @param {string} recordKey Fixed private adapter key chosen by host code.
 * @returns {object} Transactional provider-key storage with bounded validated keys.
 */
export function providerBudgetRecordStorage(storage, recordKey) {
  return { transaction: operation => storage.transaction(async tx => {
    const saved = await tx.get(recordKey)
    const validKey = key => typeof key === 'string' && key.startsWith('provider-budget:v1:') && PROVIDERS.has(key.slice('provider-budget:v1:'.length))
    if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !validKey(key)))) fail('PROVIDER_BUDGET_STATE_INVALID', 503)
    const rows = saved ?? {}
    return operation({
      get: async key => { if (!validKey(key)) fail('PROVIDER_BUDGET_STATE_INVALID', 503); return rows[key] },
      put: async (key, value) => { if (!validKey(key)) fail('PROVIDER_BUDGET_STATE_INVALID', 503); rows[key] = value; await tx.put(recordKey, rows) },
    })
  }) }
}

/** Reserve attempts and worst-case output plus input-byte allowance before dispatch.
 * Failed and uncertain upstream calls retain their reservations; callers never refund.
 * @param {object} storage Durable transaction-capable storage shared by all edge isolates.
 * @param {object} input Provider and conservative integer token reservation.
 * @param {object} limits Validated fixed-window configuration.
 * @param {number} now Server timestamp, never supplied by a browser request.
 * @returns {Promise<object>} Reservation result without upstream calls.
 */
export async function reserveProviderBudget(storage, input, limits, now = Date.now()) {
  if (!input || !PROVIDERS.has(input.provider) || !Number.isSafeInteger(input.tokens) || input.tokens < 0 || input.tokens > limits.tokens || Object.keys(input).some(key => !['provider', 'tokens'].includes(key))) fail('PROVIDER_BUDGET_REQUEST_INVALID', 400)
  return storage.transaction(async tx => {
    const key = 'provider-budget:v1:' + input.provider
    const previous = await tx.get(key)
    if (previous !== undefined && (!previous || !Number.isSafeInteger(previous.startedAt) || !Number.isSafeInteger(previous.requests) || previous.requests < 0 || !Number.isSafeInteger(previous.tokens) || previous.tokens < 0)) fail('PROVIDER_BUDGET_STATE_INVALID', 503)
    // A backward clock never resets a reservation window.
    const state = previous && now < previous.startedAt + limits.windowMs ? previous : { startedAt: now, requests: 0, tokens: 0 }
    if (state.requests >= limits.requests || state.tokens + input.tokens > limits.tokens) fail('PROVIDER_BUDGET_EXHAUSTED', 429)
    state.requests++; state.tokens += input.tokens
    await tx.put(key, state)
    return { ok: true, resetAt: state.startedAt + limits.windowMs, reservedTokens: input.tokens }
  })
}

/** Read-only, deterministic, secret-free cost proprioception snapshot over durable provider reservations.
 * Never mutates storage or depends on wall-clock time on read, preserving deterministic facts snapshots.
 */
export async function readProviderBudgetUsage(storage, env) {
  let limits = null
  try {
    limits = providerBudgetLimits(env ?? {})
  } catch {
    limits = null
  }
  const providers = {}
  let totalRequestsReserved = 0
  let totalTokensReserved = 0
  if (storage && typeof storage.transaction === 'function') {
    await storage.transaction(async tx => {
      for (const provider of [...PROVIDERS].sort()) {
        const row = await tx.get('provider-budget:v1:' + provider)
        if (row && Number.isSafeInteger(row.startedAt) && Number.isSafeInteger(row.requests) && row.requests >= 0
          && Number.isSafeInteger(row.tokens) && row.tokens >= 0) {
          providers[provider] = {
            requestsReserved: row.requests,
            tokensReserved: row.tokens,
            windowStartedAt: row.startedAt,
            windowResetAt: limits ? row.startedAt + limits.windowMs : null,
          }
          totalRequestsReserved += row.requests
          totalTokensReserved += row.tokens
        }
      }
    })
  }
  return Object.freeze({
    configured: limits !== null,
    windowMs: limits ? limits.windowMs : null,
    limits: limits
      ? { requests: limits.requests, tokens: limits.tokens, maxOutputTokens: limits.maxOutputTokens }
      : null,
    totalRequestsReserved,
    totalTokensReserved,
    providers,
  })
}
