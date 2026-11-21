/**
 * THE HAND ON HER OWN VOICE AGENT'S SETTINGS.
 *
 * Why this file exists. On 2026-11-18 every call to the managed voice connected and was ended by the provider two
 * seconds later. The provider's own record said `errorCode` 4300, "This AI agent has reached its daily limit. Please
 * try again tomorrow." — three conversations, each of zero duration. The account was healthy (active, pro, 11,407 of
 * 600,002 credits), so the wall was one number on the Speech Engine resource: `call_limits.daily_limit`. Nobody on the
 * owner's side could change it, because the edge could only GET that resource. Hours went to waiting for someone
 * outside to press a button.
 *
 * What it does, and nothing else: reads the resource, rewrites TWO numbers inside `call_limits`, and proves the result
 * by reading the resource again. It is the only write the edge makes to the provider.
 *   1. GET  /v1/speech-engine/{id}
 *   2. PATCH /v1/speech-engine/{id} with `{ call_limits: <the object as read, with two values changed> }`.
 *      The provider's reference: PATCH is a partial update, and `call_limits` is replaced as a whole, so the whole
 *      object is sent back as it was read. Sending only the two fields would silently drop every other limit.
 *   3. GET  /v1/speech-engine/{id} again, and answer with what the provider now holds.
 *
 * The two values it sets, and why each:
 *   * `daily_limit` 100000 — the provider's own default for the field (its reference says so), and the shipped choice:
 *     no daily limit of its own; spending is bounded by the account. Every press mints a
 *     conversation, so a small daily count is spent by a morning of restarts and retries.
 *   * `cascade_timeout_seconds` 15 — the bridge was built for 15 (its allowed maximum). The resource held 4, and the
 *     provider abandons and retries an attempt after that long, hanging up the call at about 17.5 s: both long calls
 *     on 2026-11-18 ended at exactly that point (`endMs` 17561 and 17590, cue `timeout`).
 *
 * Rules this file keeps, and the reasons:
 *   * The API key is read from the environment here and used only in the request header. It is never returned,
 *     logged, stored, or written into an answer. The caller never sees it.
 *   * Owner only. `managedVoiceOwner` (voice-bridge.mjs) is the same judge the owner door and the status read use: the
 *     owner's access type, his address equal to OWNER_EMAIL, case-insensitive. An ambient owner pass is not enough.
 *   * Same origin. A browser request that says it came from somewhere else is refused. A request with no Origin is
 *     judged by the owner session alone (that is what a server-side call looks like).
 *   * Nothing is invented. If the read does not contain a `call_limits` object, this refuses locally instead of
 *     sending a PATCH built out of guesses. A limit this file cannot read is a limit it will not overwrite.
 *   * Closed answers. Every reply is numbers, booleans and words from a closed list, so a failure is told apart from a
 *     silence. Nothing here throws; a broken transport is an answer, not an exception.
 *   * No secrets in the answer, no resource id, no url: the same rule voice-provider-side.mjs follows.
 *
 * Field names come from the provider's reference read on 2026-11-18 (speech-engine get/patch). UNVERIFIED against the
 * live answers until the first real call, which is what the status line below exists to prove.
 */
import { managedVoiceOwner } from './voice-bridge.mjs'

export const PROVIDER_LIMITS = Object.freeze({
  origin: 'https://api.elevenlabs.io',
  deadlineMs: 8000,
  bodyBytes: 262144,
  dailyLimit: 100000,
  cascadeTimeoutSeconds: 15,
  keyChars: 200,
})

/** Every answer's `read` and `patch` words come from here, so a refusal is never mistaken for a success. */
export const PROVIDER_LIMITS_WORDS = Object.freeze([
  'ok', 'unchanged', 'refused-local', 'not-configured', 'status-401', 'status-403', 'status-404', 'status-422',
  'status-429', 'status-5xx', 'status-other', 'timeout', 'network', 'shape', 'too-large',
])

/** The two limits this file owns. Anything else in `call_limits` is echoed back untouched. */
export const PROVIDER_LIMITS_FIELDS = Object.freeze(['daily_limit', 'cascade_timeout_seconds'])

const RESOURCE_RE = /^(?:agent|seng)_[A-Za-z0-9]{1,64}$/
const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/
const decoder = new TextDecoder('utf-8', { fatal: true })

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const whole = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The body, read to at most `max` bytes (a longer one is refused, never held). */
async function readBounded(response, max) {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const parts = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new Error('TOO_LARGE')
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const part of parts) { bytes.set(part, at); at += part.byteLength }
  return bytes
}

const statusWord = status => (status === 401 || status === 403 || status === 404 || status === 422 || status === 429
  ? `status-${String(status)}`
  : status >= 500 && status <= 599 ? 'status-5xx' : 'status-other')

/** One request to the provider. Answers { word, value }: `word` is from the closed list, `value` the parsed JSON for
 * 'ok' only. Never throws. */
async function callProvider(networkFetch, { method, path, apiKey, signal, body }) {
  const headers = { 'xi-api-key': apiKey }
  const init = { method, headers, redirect: 'manual', signal }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await networkFetch(PROVIDER_LIMITS.origin + path, init)
  } catch {
    return { word: signal?.aborted ? 'timeout' : 'network', value: null }
  }
  try {
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {})
      return { word: response.redirected ? 'status-other' : statusWord(response.status), value: null }
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => {})
      return { word: 'shape', value: null }
    }
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > PROVIDER_LIMITS.bodyBytes)) {
      await response.body?.cancel().catch(() => {})
      return { word: 'too-large', value: null }
    }
    let bytes
    try {
      bytes = await readBounded(response, PROVIDER_LIMITS.bodyBytes)
    } catch {
      return { word: signal?.aborted ? 'timeout' : 'too-large', value: null }
    }
    return { word: 'ok', value: JSON.parse(decoder.decode(bytes)) }
  } catch {
    return { word: signal?.aborted ? 'timeout' : 'shape', value: null }
  }
}

/**
 * `call_limits` as the provider holds it, closed: only plain keys, and only numbers, booleans and short strings. A
 * nested object or an array is dropped rather than echoed back into a PATCH, so nothing unreadable is ever written.
 */
export function readCallLimits(value) {
  if (!isObject(value)) return null
  const out = {}
  for (const key of Object.keys(value)) {
    if (!KEY_RE.test(key)) continue
    const item = value[key]
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item
    else if (typeof item === 'boolean') out[key] = item
    else if (typeof item === 'string' && item.length <= 64) out[key] = item
  }
  return out
}

/** The two numbers, closed, for the answer. A field the provider does not send is null, never zero. */
export function readLimitsPair(callLimits) {
  const limits = readCallLimits(callLimits)
  if (limits === null) return null
  return { dailyLimit: whole(limits.daily_limit), cascadeTimeoutSeconds: whole(limits.cascade_timeout_seconds) }
}

/**
 * Read, change the two limits, read again. Never throws.
 * @returns {Promise<{ok: boolean, read: string, patch: string, changed: boolean, before: object|null, after: object|null,
 *   requested: {dailyLimit: number, cascadeTimeoutSeconds: number}}>}
 */
export async function applyVoiceLimits({ networkFetch, apiKey, resourceId, deadlineMs = PROVIDER_LIMITS.deadlineMs }) {
  const requested = { dailyLimit: PROVIDER_LIMITS.dailyLimit, cascadeTimeoutSeconds: PROVIDER_LIMITS.cascadeTimeoutSeconds }
  const refused = word => ({ ok: false, read: word, patch: 'refused-local', changed: false, before: null, after: null, requested })
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > PROVIDER_LIMITS.keyChars) return refused('not-configured')
  if (typeof resourceId !== 'string' || !RESOURCE_RE.test(resourceId)) return refused('not-configured')
  if (typeof networkFetch !== 'function') return refused('network')

  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(deadlineMs) : undefined
  const path = `/v1/speech-engine/${resourceId}`

  const first = await callProvider(networkFetch, { method: 'GET', path, apiKey, signal })
  if (first.word !== 'ok') return refused(first.word)
  const before = isObject(first.value) ? readLimitsPair(first.value.call_limits) : null
  if (before === null) return refused('shape')

  const asRead = readCallLimits(first.value.call_limits)
  const wanted = { ...asRead, daily_limit: PROVIDER_LIMITS.dailyLimit, cascade_timeout_seconds: PROVIDER_LIMITS.cascadeTimeoutSeconds }
  const sameDaily = before.dailyLimit === PROVIDER_LIMITS.dailyLimit
  const sameCascade = before.cascadeTimeoutSeconds === PROVIDER_LIMITS.cascadeTimeoutSeconds
  if (sameDaily && sameCascade) {
    return { ok: true, read: 'ok', patch: 'unchanged', changed: false, before, after: before, requested }
  }

  const patched = await callProvider(networkFetch, { method: 'PATCH', path, apiKey, signal, body: { call_limits: wanted } })
  if (patched.word !== 'ok') return { ok: false, read: 'ok', patch: patched.word, changed: false, before, after: null, requested }

  // The write is only evidence once a second read shows the provider holding the new numbers.
  const second = await callProvider(networkFetch, { method: 'GET', path, apiKey, signal })
  if (second.word !== 'ok') return { ok: false, read: second.word, patch: 'ok', changed: true, before, after: null, requested }
  const after = isObject(second.value) ? readLimitsPair(second.value.call_limits) : null
  const held = after !== null && after.dailyLimit === PROVIDER_LIMITS.dailyLimit && after.cascadeTimeoutSeconds === PROVIDER_LIMITS.cascadeTimeoutSeconds
  return { ok: held, read: 'ok', patch: 'ok', changed: true, before, after, requested }
}

/**
 * The owner door's action: POST /_host/voice {"action":"provider_limits"}.
 * Owner (with his passkey session) and same origin, then the read-change-read above. The key stays here.
 */
export async function handleProviderLimits({ request, env, access, networkFetch, now = Date.now }) {
  if (!managedVoiceOwner(access, env, now())) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
  const origin = typeof request?.headers?.get === 'function' ? request.headers.get('Origin') : null
  let own = null
  try { own = new URL(request.url).origin } catch { own = null }
  if (origin !== null && own !== null && origin !== own) return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
  const answer = await applyVoiceLimits({
    networkFetch,
    apiKey: env?.ELEVENLABS_VOICE_API_KEY,
    resourceId: env?.ELEVENLABS_X61_VOICE_RESOURCE_ID,
  })
  if (answer.read === 'not-configured') return json({ ok: false, code: 'VOICE_NOT_CONFIGURED', ...answer }, 501)
  return json(answer, answer.ok ? 200 : 502)
}
