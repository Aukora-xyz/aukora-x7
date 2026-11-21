/** Durable conservative reservations, not provider billing or exact token metering. */
const PROVIDERS = new Set(['deepseek', 'moonshot', 'moonshot-cn', 'openrouter', 'openai', 'anthropic', 'xai', 'prime'])
const fail = (code, status, extra = {}) => { throw Object.assign(new Error(code), { code, status, ...extra }) }

// ---- PRIME block begin: the Prime Intellect door's settings and its durable, mandatory spending cap ----
/** The ONE address her Prime calls go to. A constant, never a setting: a settable address could send her prompts anywhere. */
export const PRIME_ORIGIN = 'https://api.pinference.ai/api'
/** The five settings, in the order a refusal names the first one absent or malformed. The key is a Worker secret. */
export const PRIME_SETTING_NAMES = Object.freeze(['PRIME_API_KEY', 'PRIME_DAILY_CAP_USD', 'PRIME_MONTHLY_CAP_USD', 'PRIME_PRICE_IN_PER_M_USD', 'PRIME_PRICE_OUT_PER_M_USD'])
/** One row in HEAD's storage: this UTC day's and month's spend (micro-USD) and the charges not yet settled. */
export const PRIME_SPEND_KEY = 'provider-budget:v1:prime:spend'
/** Charges kept open for settling; the oldest beyond this is dropped and simply stays charged at its estimate. */
export const PRIME_OPEN_CHARGES_MAX = 64
const PRIME_DECIMAL = /^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,6})?$/
const PRIME_TEAM = /^[A-Za-z0-9_-]{1,128}$/
const PRIME_CHARGE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DAY_MS = 86400000
/** A plain decimal string of US dollars as integer micro-dollars, or null (no exponent, sign, space or number type). */
const microUsd = value => {
  if (typeof value !== 'string' || !PRIME_DECIMAL.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 1000000 + Number(fraction.padEnd(6, '0'))
}
const primeKeyPresent = env => typeof env?.PRIME_API_KEY === 'string' && env.PRIME_API_KEY.trim().replace(/^Bearer(?:\s+|$)/i, '').trim() !== ''

/** The validated Prime settings (never the key's value), or the first setting absent or malformed, by its exact name.
 * A cap may be "0" (no spend at all); a price must be above zero, or the cap would count nothing. PRIME_TEAM_ID is
 * optional; when set it must be a plain identifier, so a call never bills an account the owner did not name.
 * @param {object} env Deployment configuration.
 * @returns {{ ok: true, dayCap: number, monthCap: number, priceIn: number, priceOut: number, teamId: string|null } | { ok: false, missing: string }}
 */
export function primeSettings(env) {
  if (!primeKeyPresent(env)) return Object.freeze({ ok: false, missing: 'PRIME_API_KEY' })
  const values = PRIME_SETTING_NAMES.slice(1).map(name => microUsd(env?.[name]))
  const bad = values.findIndex((value, index) => value === null || (index >= 2 && value === 0))
  if (bad !== -1) return Object.freeze({ ok: false, missing: PRIME_SETTING_NAMES[bad + 1] })
  const team = typeof env?.PRIME_TEAM_ID === 'string' ? env.PRIME_TEAM_ID.trim() : ''
  if (team !== '' && !PRIME_TEAM.test(team)) return Object.freeze({ ok: false, missing: 'PRIME_TEAM_ID' })
  const [dayCap, monthCap, priceIn, priceOut] = values
  return Object.freeze({ ok: true, dayCap, monthCap, priceIn, priceOut, teamId: team || null })
}

/** True only when all five settings are present and well formed (what the health and selftest booleans show). */
export const primeConfigured = env => primeSettings(env).ok === true

/** The team the call bills, or null (the key owner's own account). Only a valid PRIME_TEAM_ID is ever sent. */
export const primeTeamId = env => { const settings = primeSettings(env); return settings.ok ? settings.teamId : null }

/** The Prime models the door may send to, each with Prime's own list price in micro-USD per million units [in, out], read
 * from Prime's public model list on 2026-11-14 (unlock/PRIME-FACTS.md; not rechecked live: UNVERIFIED). A model is sent
 * only when it is here AND both its list prices are at or below the set prices, so the estimate (units x the set prices)
 * is never below what Prime lists for it. A model not here has an unknown price and is refused. When Prime changes a
 * price, change its row here; a model whose row is dearer than the set prices waits until the owner raises them. */
export const PRIME_MODEL_PRICES = Object.freeze(Object.fromEntries(Object.entries({
  'moonshotai/kimi-k3.1-pro': [2000000, 10000000], 'z-ai/glm-5.2': [1540000, 4840000], 'deepseek/deepseek-v4-pro': [1910000, 3830000],
  'qwen/qwen3.5-397b-a17b': [600000, 3600000], 'anthropic/claude-sonnet-5.5': [2000000, 10000000], 'openai/gpt-6-sol': [2000000, 10000000],
  'deepseek/deepseek-v4-flash': [440000, 1320000], 'deepseek/deepseek-v4-flash-0731': [440000, 1320000], 'deepseek/deepseek-v4.1-flash-1017': [43680, 700000],
  'z-ai/glm-4.7-flash': [70000, 400000], 'qwen/qwen3.8-27b': [450000, 3200000], 'nvidia/nemotron-3.5-lightning': [70000, 200000],
  'openai/gpt-5.6-luna': [200000, 1200000], 'openai/gpt-6-luna': [100000, 500000], 'openai/gpt-oss-120b': [350000, 750000],
  'google/gemini-3.8-flash': [750000, 3750000], 'deepseek/deepseek-v3.2': [370500, 1111500], 'qwen/qwen3-coder': [975000, 4875000],
  'qwen/qwen3-coder-next': [300000, 1500000], 'Qwen/Qwen3-235B-A22B-Instruct-2507': [250000, 1000000], 'moonshotai/kimi-k2.5': [600000, 3000000],
  'moonshotai/kimi-k2.6': [950000, 4000000], 'moonshotai/kimi-k2.7-code': [1900000, 8000000], 'z-ai/glm-5': [1000000, 3200000],
  'z-ai/glm-5.1': [1400000, 4400000], 'meta-llama/llama-3.3-70b-instruct': [1040000, 2253000], 'meta-llama/llama-4-maverick': [350000, 1150000],
  'x-ai/grok-4.7': [1600000, 4800000],
  // Dearer than the committed $2 / $10: refused until the owner raises the set prices to at least these.
  'openai/gpt-5.6-terra': [2500000, 15000000], 'moonshotai/kimi-k3': [3450000, 17250000], 'anthropic/claude-opus-5.5': [4000000, 20000000],
  'anthropic/claude-fable-5.2': [8000000, 40000000], 'openai/gpt-6-astra': [10000000, 50000000],
}).map(([model, prices]) => [model, Object.freeze(prices)])))
const PRIME_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,199}$/

/** Whether the door may send to this model under these settings: listed, and priced at or below the set prices.
 * @param {ReturnType<typeof primeSettings>} settings
 * @param {unknown} model
 */
export function primeModelAllowed(settings, model) {
  if (settings?.ok !== true || typeof model !== 'string' || !Object.hasOwn(PRIME_MODEL_PRICES, model)) return false
  const [priceIn, priceOut] = PRIME_MODEL_PRICES[model]
  return priceIn <= settings.priceIn && priceOut <= settings.priceOut
}

/** Upper estimate in micro-USD: units x price per million, rounded up. Units are the edge's reserved units, not a bill. */
export const primeEstimate = (priceIn, priceOut, inputUnits, outputUnits) =>
  Number((BigInt(inputUnits) * BigInt(priceIn) + BigInt(outputUnits) * BigInt(priceOut) + 999999n) / 1000000n)

function primeRow(stored) {
  if (stored === undefined) return { day: '', dayMicros: 0, month: '', monthMicros: 0, open: {} }
  const count = value => Number.isSafeInteger(value) && value >= 0
  if (!stored || typeof stored !== 'object' || typeof stored.day !== 'string' || typeof stored.month !== 'string' || !count(stored.dayMicros) || !count(stored.monthMicros)
    || !stored.open || typeof stored.open !== 'object' || Array.isArray(stored.open)) fail('PROVIDER_BUDGET_STATE_INVALID', 503)
  // ---- Prime budget begin: clone stored row + open map before mutating so failed writes never corrupt state ----
  const open = {}
  for (const [id, entry] of Object.entries(stored.open)) open[id] = entry && typeof entry === 'object' ? { ...entry } : entry
  return { day: stored.day, dayMicros: stored.dayMicros, month: stored.month, monthMicros: stored.monthMicros, open }
  // ---- PRIME-BUDGET end ----
}

/** Inside the reservation's own transaction: roll the UTC day and month over (the speech ledger's day key, the voice
 * bridge's day+month rollover), refuse over either cap, else charge the estimate and keep the charge open to settle. */
async function chargePrime(tx, settings, units, now) {
  const iso = new Date(now).toISOString()
  const stored = await tx.get(PRIME_SPEND_KEY) // Keep uninitialized marker for $0 calls
  const row = primeRow(stored)
  // A backward clock never reopens a window: a stored later day or month keeps counting.
  if (iso.slice(0, 10) > row.day) Object.assign(row, { day: iso.slice(0, 10), dayMicros: 0 })
  if (iso.slice(0, 7) > row.month) Object.assign(row, { month: iso.slice(0, 7), monthMicros: 0 })
  const micros = primeEstimate(settings.priceIn, settings.priceOut, units.input, units.output)
  if (row.monthMicros + micros > settings.monthCap) fail('SPEND_CAP_EXCEEDED', 429, { window: 'month', retryAt: Date.UTC(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)), 1) })
  if (row.dayMicros + micros > settings.dayCap) fail('SPEND_CAP_EXCEEDED', 429, { window: 'day', retryAt: Date.parse(row.day + 'T00:00:00Z') + DAY_MS })
  // ---- Prime budget begin: zero-cost calls (e.g. GET /door/prime/v1/models) never insert into row.open ----
  if (micros === 0) {
    if (stored !== undefined && (row.day !== stored.day || row.month !== stored.month)) await tx.put(PRIME_SPEND_KEY, row)
    return { chargeId: null, estimateMicroUsd: 0, day: row.day, month: row.month }
  }
  // ---- PRIME-BUDGET end ----
  row.dayMicros += micros
  row.monthMicros += micros
  const chargeId = crypto.randomUUID()
  row.open[chargeId] = { micros, day: row.day, month: row.month, priceIn: settings.priceIn, priceOut: settings.priceOut }
  const ids = Object.keys(row.open)
  for (const id of ids.slice(0, Math.max(0, ids.length - PRIME_OPEN_CHARGES_MAX))) delete row.open[id]
  await tx.put(PRIME_SPEND_KEY, row)
  return { chargeId, estimateMicroUsd: micros, day: row.day, month: row.month }
}

/** Settle one open charge ONCE: down to the units the provider says were used (never above the estimate), or to zero
 * for a call that never left the edge. `used` null leaves the estimate counted. Unknown or settled ids change nothing.
 * @param {object} storage HEAD's transaction-capable storage.
 * @param {string} chargeId The id reserveProviderBudget answered.
 * @param {{ inputUnits: number, outputUnits: number } | null} used
 */
export async function settlePrimeSpend(storage, chargeId, used) {
  if (typeof chargeId !== 'string' || !PRIME_CHARGE.test(chargeId) || !used || ![used.inputUnits, used.outputUnits].every(value => Number.isSafeInteger(value) && value >= 0)) return { ok: true, settled: false }
  return storage.transaction(async tx => {
    const stored = await tx.get(PRIME_SPEND_KEY)
    if (stored === undefined) return { ok: true, settled: false }
    const row = primeRow(stored)
    const entry = Object.hasOwn(row.open, chargeId) ? row.open[chargeId] : null
    if (!entry) return { ok: true, settled: false }
    delete row.open[chargeId]
    const actual = Math.min(entry.micros, primeEstimate(entry.priceIn, entry.priceOut, used.inputUnits, used.outputUnits))
    const refund = entry.micros - actual
    if (entry.day === row.day) row.dayMicros = Math.max(0, row.dayMicros - refund)
    if (entry.month === row.month) row.monthMicros = Math.max(0, row.monthMicros - refund)
    await tx.put(PRIME_SPEND_KEY, row)
    return { ok: true, settled: true, chargedMicroUsd: actual }
  })
}

/** Codes the cloud model door answers before any byte leaves the edge. */
const PRIME_NEVER_LEFT = Object.freeze(['PROVIDER_SECRET_NOT_CONFIGURED', 'PROVIDER_REQUEST_INVALID', 'PROVIDER_DISPATCH_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'])

/** What a whole (not streamed) cloud-model-door answer says was used: zero for a call that never left the edge, the
 * OpenAI-shape `usage` counts when the answer carries them (Prime's own field names are UNVERIFIED), else null (keep). */
export function primeUsedFromAnswer(turn) {
  if (turn?.ok !== true) return PRIME_NEVER_LEFT.includes(turn?.code) ? { inputUnits: 0, outputUnits: 0 } : null
  const count = value => Number.isSafeInteger(value) && value >= 0
  const usage = turn.usage
  return usage && count(usage.prompt_tokens) && count(usage.completion_tokens) ? { inputUnits: usage.prompt_tokens, outputUnits: usage.completion_tokens } : null
}

/** A Prime refusal as HEAD and the Worker answer it (code, status and its one detail), or null. Never carries the key. */
export function primeRefusal(error) {
  if (error?.code === 'SPEND_CAP_EXCEEDED' && ['day', 'month'].includes(error.window) && Number.isSafeInteger(error.retryAt)) return { ok: false, code: 'SPEND_CAP_EXCEEDED', status: 429, window: error.window, retryAt: error.retryAt }
  if (error?.code === 'PRIME_NOT_CONFIGURED' && [...PRIME_SETTING_NAMES, 'PRIME_TEAM_ID'].includes(error.missing)) return { ok: false, code: 'PRIME_NOT_CONFIGURED', status: 503, missing: error.missing }
  if (error?.code === 'PRIME_MODEL_NOT_ALLOWED' && typeof error.model === 'string' && PRIME_MODEL.test(error.model)) return { ok: false, code: 'PRIME_MODEL_NOT_ALLOWED', status: 403, model: error.model }
  return null
}

/** A Prime refusal's one detail, for an answer or a step log: { window, retryAt }, { missing } or { model }. */
export const primeRefusalDetail = refusal => refusal.code === 'SPEND_CAP_EXCEEDED' ? { window: refusal.window, retryAt: refusal.retryAt }
  : refusal.code === 'PRIME_NOT_CONFIGURED' ? { missing: refusal.missing } : { model: refusal.model }
// ---- PRIME block end ----

/** Validate deployment quotas. Missing or invalid configuration disables provider requests.
 * @param {object} env Deployment configuration, never request input.
 * @returns {object} Fixed-window request and reserved-token limits.
 */
export function providerBudgetLimits(env) {
  const limits = { windowMs: Number(env.PROVIDER_BUDGET_WINDOW_MS), requests: Number(env.PROVIDER_BUDGET_REQUESTS), tokens: Number(env.PROVIDER_BUDGET_TOKENS), maxOutputTokens: Number(env.PROVIDER_MAX_OUTPUT_TOKENS) }
  if (!Object.values(limits).every(Number.isSafeInteger) || limits.windowMs < 60000 || limits.windowMs > 3600000 || limits.requests < 1 || limits.requests > 10000 || limits.tokens < 1 || limits.tokens > 100000000 || limits.maxOutputTokens < 1 || limits.maxOutputTokens > 1000000 || limits.maxOutputTokens > limits.tokens) fail('PROVIDER_BUDGET_UNCONFIGURED', 503)
  limits.prime = primeSettings(env) // Validated with the limits, so every reservation sees it; never the key's value
  return Object.freeze(limits)
}

/** Accept only self-contained text and client function-tool requests whose input allowance can be bounded.
 * Remote files, stored conversations, server tools and unspecified output ceilings
 * are refused rather than assigned a misleading byte-derived token reservation.
 * @param {Uint8Array|undefined} bytes Complete bounded JSON body for a POST, absent for model listing.
 * @param {object} limits Validated deployment limits.
 * @param {string} pathname Provider wire endpoint, without query parameters.
 * @param {{ assistantReasoning?: boolean }} [options] the wake: `assistantReasoning` is passed by HEAD's no-tab wake
 *   only (never from a request): its assistant turns may carry the thinking model's own `reasoning_content` back to it.
 * @returns {object} Requested model and conservative text-input/output reservation, not a monetary cap.
 */
export function providerRequestReservation(bytes, limits, pathname, { assistantReasoning = false } = {}) {
  if (bytes === undefined) {
    if (typeof pathname !== 'string' || !pathname.endsWith('/models')) fail('PROVIDER_ENDPOINT_UNAVAILABLE', 404)
    return { requestedModel: null, tokens: 0, outputTokens: 0 }
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
    ...(wire === 'chat' ? ['messages', 'stop', 'n', 'parallel_tool_calls'] : wire === 'messages' ? ['messages', 'system', 'stop_sequences', 'thinking', 'output_config', 'metadata', 'top_k', 'fallbacks'] : ['input', 'instructions', 'parallel_tool_calls', 'store'])])
  if (!record(input) || Object.keys(input).some(key => !fields.has(key))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  if (typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,199}$/.test(input.model) || (input.n !== undefined && input.n !== 1)) fail('PROVIDER_BUDGET_REQUEST_INVALID', 400)
  if (input.thinking !== undefined && !(record(input.thinking) && only(input.thinking, ['type', 'budget_tokens']) && ['enabled', 'disabled'].includes(input.thinking.type) && (input.thinking.budget_tokens === undefined || (Number.isSafeInteger(input.thinking.budget_tokens) && input.thinking.budget_tokens >= 1)))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  // The five documented effort levels (claude-api shared/model-migration.md, "Choosing an effort level").
  if (input.output_config !== undefined && !(only(input.output_config, ['effort']) && ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.output_config.effort))) fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  // Server-side refusal fallbacks, only in the `"default"` scalar form (claude-api curl/examples.md, "Refusal
  // Fallbacks"); the array form, which names models, is refused here.
  if (input.fallbacks !== undefined && input.fallbacks !== 'default') fail('PROVIDER_REQUEST_SHAPE_UNSUPPORTED', 400)
  // A cache mark is exactly `{ type: 'ephemeral' }` (5 minutes) or the same with ttl '1h' (claude-api
  // shared/prompt-caching.md, "API reference", lines 122-124), or with ttl '5m', the default's own name (the same file,
  // line 208, counts it as `ephemeral_5m`), wherever this check accepts one; nothing else.
  const cacheMark = value => value === undefined || (only(value, ['type', 'ttl']) && value.type === 'ephemeral' && (value.ttl === undefined || ['5m', '1h'].includes(value.ttl)))
  const functionDefinition = (value, anthropic = false) => only(value, anthropic ? ['name', 'description', 'input_schema', 'defer_loading', 'cache_control'] : ['name', 'description', 'parameters', 'strict'])
    && cacheMark(value.cache_control) && identifier(value.name) && (value.description === undefined || typeof value.description === 'string') && (value.strict === undefined || typeof value.strict === 'boolean')
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
  const textBlock = block => only(block, ['type', 'text', 'cache_control']) && ['text', 'input_text', 'output_text'].includes(block.type) && typeof block.text === 'string' && cacheMark(block.cache_control)
  const wireInput = block => textBlock(block) || (only(block, ['type', 'source']) && block.type === 'image' && record(block.source) && only(block.source, ['type', 'media_type', 'data']) && block.source.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string')
  const chatCall = call => only(call, ['id', 'type', 'function']) && identifier(call.id) && call.type === 'function' && only(call.function, ['name', 'arguments']) && identifier(call.function.name) && typeof call.function.arguments === 'string'
  const anthropicBlock = block => wireInput(block)
    || (only(block, ['type', 'thinking', 'signature']) && block.type === 'thinking' && typeof block.thinking === 'string' && (block.signature === undefined || typeof block.signature === 'string'))
    // A server-side fallback switch point, echoed back in place (claude-api shared/model-migration.md,
    // "`refusal` stop reason" -> "Echoing fallback turns back"; its shape `{type, from: {model}, to: {model}}` is the one
    // that section gives).
    || (only(block, ['type', 'from', 'to']) && block.type === 'fallback' && only(block.from, ['model']) && identifier(block.from.model) && only(block.to, ['model']) && identifier(block.to.model))
    || (only(block, ['type', 'tool']) && ['tool_addition', 'tool_removal'].includes(block.type) && record(block.tool) && only(block.tool, ['type', 'name']) && block.tool.type === 'tool_reference' && identifier(block.tool.name))
    // tool_use and tool_result blocks may carry a cache mark (prompt-caching.md line 128): the block that ends
    // every agent step is a tool_result, so the growing conversation can be read back from the cache.
    || (only(block, ['type', 'id', 'name', 'input', 'cache_control']) && block.type === 'tool_use' && identifier(block.id) && identifier(block.name) && record(block.input) && selfContained(block.input) && cacheMark(block.cache_control))
    || (only(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']) && block.type === 'tool_result' && identifier(block.tool_use_id) && (typeof block.content === 'string' || boundedOptionalList(block.content, wireInput)) && (block.is_error === undefined || typeof block.is_error === 'boolean') && cacheMark(block.cache_control))
  // ONLY on the wake's own path (assistantReasoning) may an assistant turn carry the thinking
  // model's `reasoning_content` (a string) back to it; every browser provider door refuses the field as before.
  const chatMessage = message => only(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'name', ...(assistantReasoning === true ? ['reasoning_content'] : [])]) && ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)
    && (message.reasoning_content === undefined || (assistantReasoning === true && message.role === 'assistant' && typeof message.reasoning_content === 'string'))
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
  // OutputTokens is the output share of `tokens`, so a spend estimate prices input and output apart.
  return { requestedModel: input.model, bodyBytes, tokens: Math.max(bytes.byteLength, bodyBytes.byteLength) + 1024 + messageCount * 256 + (input.tools?.length ?? 0) * 256 + maxima[0], outputTokens: maxima[0] }
}

/** Adapt one private atomic JSON record to the shared provider quota store.
 * @param {object} storage Single-record durable storage; owns locks, filesystem security and atomic replacement.
 * @param {string} recordKey Fixed private adapter key chosen by host code.
 * @returns {object} Transactional provider-key storage with bounded validated keys.
 */
export function providerBudgetRecordStorage(storage, recordKey) {
  return { transaction: operation => storage.transaction(async tx => {
    const saved = await tx.get(recordKey)
    const validKey = key => typeof key === 'string' && key.startsWith('provider-budget:v1:') && (PROVIDERS.has(key.slice('provider-budget:v1:'.length)) || key === PRIME_SPEND_KEY)
    if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !validKey(key)))) fail('PROVIDER_BUDGET_STATE_INVALID', 503)
    // ---- Prime budget begin: clone record map before mutating so failed tx.put or cap refusal never mutates saved ----
    const rows = saved ? { ...saved } : {}
    return operation({
      get: async key => { if (!validKey(key)) fail('PROVIDER_BUDGET_STATE_INVALID', 503); return rows[key] },
      put: async (key, value) => { if (!validKey(key)) fail('PROVIDER_BUDGET_STATE_INVALID', 503); const next = { ...rows, [key]: value }; await tx.put(recordKey, next); rows[key] = value },
    })
    // ---- PRIME-BUDGET end ----
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
  // A prime reservation also names its output share and its model; every other provider's input shape is unchanged.
  const prime = input?.provider === 'prime'
  if (!input || !PROVIDERS.has(input.provider) || !Number.isSafeInteger(input.tokens) || input.tokens < 0 || input.tokens > limits.tokens || Object.keys(input).some(key => !(prime ? ['provider', 'tokens', 'outputTokens', 'model'] : ['provider', 'tokens']).includes(key))) fail('PROVIDER_BUDGET_REQUEST_INVALID', 400)
  if (prime && (!Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0 || input.outputTokens > input.tokens)) fail('PROVIDER_BUDGET_REQUEST_INVALID', 400)
  // Only the model listing (nothing reserved) names no model; every other prime call names a well-formed one.
  if (prime && !(input.model === null ? input.tokens === 0 : typeof input.model === 'string' && PRIME_MODEL.test(input.model))) fail('PROVIDER_BUDGET_REQUEST_INVALID', 400)
  // No prime call without all five settings: the cap is mandatory, never skipped.
  const primeConfig = prime ? (limits.prime ?? { ok: false, missing: PRIME_SETTING_NAMES[0] }) : null
  if (prime && primeConfig.ok !== true) fail('PRIME_NOT_CONFIGURED', 503, { missing: primeConfig.missing })
  // The estimate prices every unit at the set prices, so it bounds the bill only for a model listed at or
  // below them. Any other model is refused before anything is written: the cap stays a cap.
  if (prime && input.model !== null && !primeModelAllowed(primeConfig, input.model)) fail('PRIME_MODEL_NOT_ALLOWED', 403, { model: input.model })
  return storage.transaction(async tx => {
    const key = 'provider-budget:v1:' + input.provider
    const previous = await tx.get(key)
    if (previous !== undefined && (!previous || !Number.isSafeInteger(previous.startedAt) || !Number.isSafeInteger(previous.requests) || previous.requests < 0 || !Number.isSafeInteger(previous.tokens) || previous.tokens < 0)) fail('PROVIDER_BUDGET_STATE_INVALID', 503)
    // A backward clock never resets a reservation window.
    // ---- Prime budget begin: clone previous window record before mutating so SPEND_CAP_EXCEEDED never mutates caller state ----
    const state = previous && now < previous.startedAt + limits.windowMs
      ? { startedAt: previous.startedAt, requests: previous.requests, tokens: previous.tokens }
      : { startedAt: now, requests: 0, tokens: 0 }
    // ---- PRIME-BUDGET end ----
    if (state.requests >= limits.requests || state.tokens + input.tokens > limits.tokens) fail('PROVIDER_BUDGET_EXHAUSTED', 429)
    state.requests++; state.tokens += input.tokens
    // The spend cap is checked and charged in this same transaction; a refusal writes nothing.
    const spend = prime ? await chargePrime(tx, primeConfig, { input: input.tokens - input.outputTokens, output: input.outputTokens }, now) : null
    await tx.put(key, state)
    return { ok: true, resetAt: state.startedAt + limits.windowMs, reservedTokens: input.tokens, ...(spend ? { spend } : {}) }
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
