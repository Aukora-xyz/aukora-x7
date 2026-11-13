/** Foundational Mouth-Brain Duplex Voice Director (`aukora.voice-director.v1`).
 *
 * Implements this architectural boundary:
 *  1. The Sovereign Agent owns the semantic channel (memory DAG, receipts, tools) and
 *     emits grounded speakable clauses (`{ text, urgency, interruptible, turnId }`),
 *     never raw JSON or raw tool output.
 *  2. PersonaPlex (`nvidia/personaplex-7b-v1`, Moshi 7B full-duplex 24 kHz / 80 ms frame)
 *     owns only the surface audio channel (pinned voice embedding, prosody, backchannels,
 *     native barge-in). When the agent clause queue is empty, the director requires
 *     `backchannel_only` (`allowSubstantiveGeneration: false`). Raw renderer bridging is
 *     disabled until a journaled, enforceable renderer protocol is implemented.
 *  3. Speech calls NEVER directly activate or authorize an agent: every spoken user turn
 *     must pass through the durable HeadDO turn journal (`turnId` committed before
 *     dispatch, `signerRole: "voice-transcript-unconfirmed"`, `voiceAuthority: "none"`),
 *     and barge-in cancels by `turnId` so no tool call or stale clause is orphaned.
 */

import { ELEVEN_SPEECH_ACTIONS, handleElevenSpeech, herVoiceField } from './eleven-speech.mjs' // VOICE hook
export const VOICE_DIRECTOR_PROTOCOL = 'aukora.voice-director.v1'
export const VOICE_CLAUSE_SCHEMA = 'aukora.voice-clause.v1'
export const VOICE_STATE_SLOT_SCHEMA = 'aukora.voice-state-slot.v1'
export const VOICE_STATE_MAX_BYTES = 1200 // ~300 tokens in pinned attention-sink slot
export const VOICE_CLAUSE_MAX_CHARS = 600
export const VOICE_TRANSCRIPT_MAX_CHARS = 4000

export const PERSONAPLEX_VOICES = Object.freeze([
  'NATF0', 'NATF1', 'NATF2', 'NATF3',
  'NATM0', 'NATM1', 'NATM2', 'NATM3',
  'VARF0', 'VARF1', 'VARF2', 'VARF3',
  'VARM0', 'VARM1', 'VARM2', 'VARM3',
])

const VOICE_SET = new Set(PERSONAPLEX_VOICES)
const DEFAULT_VOICE = 'NATF1'
const ALLOWED_BACKCHANNELS = Object.freeze(['mm-hm', 'right', 'one sec'])
const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const CLAUSE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const HEX_64 = /^[0-9a-f]{64}$/
const SPEECH_PASS_TTL_SECONDS = 30
const SPEECH_PASS_TIMEOUT_MS = 5000
const SPEECH_PASS_MAX_BYTES = 8192

const encoder = new TextEncoder()

const boundedSummary = (value, limit) => Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, limit).join('')

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function voiceError(code, status = 400) {
  return Object.assign(new Error(code), { code, status })
}

// Deepgram documents ttl_seconds and access_token/expires_in at:
// https://developers.deepgram.com/reference/auth/tokens/grant
async function mintSpeechPass(request, apiKey, networkFetch, env, seedId, access) {
  const controller = new AbortController()
  const deadlineAt = performance.now() + SPEECH_PASS_TIMEOUT_MS
  let timer, reader, stopped, rejectDeadline
  const deadline = new Promise((_, reject) => { rejectDeadline = reject })
  const cancel = error => {
    if (stopped) return
    stopped = error
    rejectDeadline(error)
    controller.abort()
    // Upstream cancellation cannot extend the request deadline.
    if (reader) void reader.cancel().catch(_error => {})
  }
  const onAbort = () => cancel(voiceError('SPEECH_REQUEST_CANCELLED', 499))
  const check = () => {
    if (request.signal.aborted) onAbort()
    if (performance.now() >= deadlineAt) cancel(voiceError('SPEECH_PROVIDER_TIMEOUT', 504))
    if (stopped) throw stopped
  }
  const readJson = async (response, maxBytes) => {
    const length = response.headers.get('content-length')
    if (stopped || request.signal.aborted || performance.now() >= deadlineAt || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      void response.body?.cancel().catch(_error => {})
      check()
      throw voiceError('SPEECH_PROVIDER_FAILED', 502)
    }
    reader = response.body?.getReader()
    if (!reader) throw voiceError('SPEECH_PROVIDER_FAILED', 502)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '', size = 0
    for (;;) {
      check()
      const { done, value } = await reader.read()
      check()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw voiceError('SPEECH_PROVIDER_FAILED', 502)
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    reader.releaseLock()
    reader = null
    return JSON.parse(text)
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  timer = setTimeout(() => cancel(voiceError('SPEECH_PROVIDER_TIMEOUT', 504)), SPEECH_PASS_TIMEOUT_MS)
  try {
    return await Promise.race([deadline, (async () => {
      check()
      let budgetResponse, budget
      try {
        budgetResponse = await env.HEAD.get(env.HEAD.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_head/speech-pass-budget', {
          method: 'POST', signal: controller.signal,
          headers: {
            'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId,
            'x-x6-verified-access': JSON.stringify({ type: access.type, email: access.email, expires: access.expires }),
          },
          body: '{}',
        }))
        budget = await readJson(budgetResponse, 1024)
      } catch (_error) {
        check()
        throw voiceError('SPEECH_PASS_BUDGET_UNAVAILABLE', 503)
      }
      if (budgetResponse.status === 429 && budget?.ok === false && budget.code === 'SPEECH_PASS_RATE_LIMITED'
        && Number.isSafeInteger(budget.retryAfterMs) && budget.retryAfterMs > 0 && budget.retryAfterMs <= 60000) {
        throw Object.assign(voiceError('SPEECH_PASS_RATE_LIMITED', 429), { retryAfterMs: budget.retryAfterMs })
      }
      if (!budgetResponse.ok || budget?.ok !== true || !Number.isSafeInteger(budget.remaining) || budget.remaining < 0 || budget.remaining > 5) {
        throw voiceError('SPEECH_PASS_BUDGET_UNAVAILABLE', 503)
      }
      check()
      const response = await networkFetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: SPEECH_PASS_TTL_SECONDS }),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(_error => {})
        check()
        throw voiceError('SPEECH_PROVIDER_FAILED', 502)
      }
      const parsed = await readJson(response, SPEECH_PASS_MAX_BYTES)
      const expiresInSeconds = parsed?.expires_in === undefined ? SPEECH_PASS_TTL_SECONDS : parsed.expires_in
      if (!isObject(parsed) || typeof parsed.access_token !== 'string'
        || !/^[A-Za-z0-9._~-]{1,4096}$/.test(parsed.access_token) || parsed.access_token.includes(apiKey)
        || !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > SPEECH_PASS_TTL_SECONDS) {
        throw voiceError('SPEECH_PROVIDER_FAILED', 502)
      }
      check()
      return { ok: true, provider: 'deepgram', accessToken: parsed.access_token, expiresInSeconds }
    })()])
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
    controller.abort()
    if (reader) void reader.cancel().catch(_error => {})
  }
}

async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// An unset or empty pin permits any WSS host; a configured pin must match the parsed hostname exactly.
function validRendererWsUrl(raw, env) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = new URL(raw.trim())
    if (parsed.protocol !== 'wss:' || !parsed.hostname || parsed.username || parsed.password) return null
    const allowedHost = env?.PERSONAPLEX_ALLOWED_HOST
    if (allowedHost !== undefined && allowedHost !== '') {
      if (typeof allowedHost !== 'string' || !allowedHost.trim()
        || parsed.hostname !== allowedHost.trim().toLowerCase()) return null
    }
    return parsed
  } catch {
    return null
  }
}

/** Prepare renderer credentials without enabling the unsupported WebSocket bridge.
 * @param {object} env Optional PERSONAPLEX_AUTH_TOKEN and paired CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET strings.
 * @returns {object} Bearer and paired Access headers; missing or blank credentials are omitted.
 */
export function buildRendererAuthHeaders(env = {}) {
  const headers = {}
  const token = typeof env.PERSONAPLEX_AUTH_TOKEN === 'string' ? env.PERSONAPLEX_AUTH_TOKEN.trim() : ''
  if (token) headers.authorization = `Bearer ${token}`
  const clientId = typeof env.CF_ACCESS_CLIENT_ID === 'string' ? env.CF_ACCESS_CLIENT_ID.trim() : ''
  const clientSecret = typeof env.CF_ACCESS_CLIENT_SECRET === 'string' ? env.CF_ACCESS_CLIENT_SECRET.trim() : ''
  if (clientId && clientSecret) {
    headers['CF-Access-Client-Id'] = clientId
    headers['CF-Access-Client-Secret'] = clientSecret
  }
  return headers
}

/** Deterministic, secret-free status projection suitable for `/_host/voice`, `/__x6/facts`, and `/api/health`. */
export function projectVoiceStatus(env) {
  const configured = validRendererWsUrl(env?.PERSONAPLEX_WS_URL, env) !== null
  const preferredVoice = typeof env?.PERSONAPLEX_DEFAULT_VOICE === 'string'
    && VOICE_SET.has(env.PERSONAPLEX_DEFAULT_VOICE.trim())
    ? env.PERSONAPLEX_DEFAULT_VOICE.trim()
    : DEFAULT_VOICE
  return Object.freeze({
    protocol: VOICE_DIRECTOR_PROTOCOL,
    configured,
    bridgeAvailable: false,
    rendererEnforcement: 'unavailable',
    architecture: 'mouth-brain-duplex',
    renderMode: 'forced_text_stream',
    idlePolicy: 'backchannel_only',
    voiceAuthority: 'none',
    speechActivatesAgentDirectly: false,
    defaultVoice: preferredVoice,
    supportedVoices: PERSONAPLEX_VOICES,
    stateSlotMaxBytes: VOICE_STATE_MAX_BYTES,
  })
}

/** Enforced idle directive when the agent has no grounded speakable clause queued. */
export function idleVoiceDirective() {
  return Object.freeze({
    schema: VOICE_CLAUSE_SCHEMA,
    mode: 'backchannel_only',
    allowSubstantiveGeneration: false,
    allowedBackchannels: ALLOWED_BACKCHANNELS,
  })
}

/** Validate a single grounded speakable clause (`agent -> voice`), refusing raw JSON/tool payloads. */
export function validateSpeakableClause(input) {
  if (input === null || input === undefined) return idleVoiceDirective()
  if (!isObject(input)) throw voiceError('VOICE_CLAUSE_INVALID', 400)
  const turnId = typeof input.turnId === 'string' && TURN_ID_RE.test(input.turnId) ? input.turnId : null
  if (!turnId) throw voiceError('VOICE_TURN_ID_INVALID', 400)
  const clauseId = typeof input.clauseId === 'string' && CLAUSE_ID_RE.test(input.clauseId)
    ? input.clauseId
    : `${turnId}-c0`
  if (typeof input.text !== 'string') throw voiceError('VOICE_CLAUSE_TEXT_REQUIRED', 400)
  const trimmed = input.text.trim()
  if (!trimmed || trimmed.length > VOICE_CLAUSE_MAX_CHARS) {
    throw voiceError('VOICE_CLAUSE_LENGTH_INVALID', 400)
  }
  const backtickParts = trimmed.split('`')
  // Never permit raw JSON, executable code spans, or tool arguments across the mouth boundary.
  if (
    /[{}]/.test(trimmed)
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || trimmed.includes('```')
    || backtickParts.length % 2 === 0
    || backtickParts.some((part, index) => index % 2 === 1 && (part.length > 40 || /[;()={}]/.test(part)))
    || /\b[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:-]{2,}/.test(trimmed)
    || /\b(?:tool_call_id|function_call_output)\b/.test(trimmed)
    || /(?:sk-ant-|sk-)[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]{9,}(?:\.[A-Za-z0-9_-]+)*/.test(trimmed)
    || /-----\s*(?:BEGIN|END)\s+[^\r\n]*-----/.test(trimmed)
    || /\b[0-9a-f]{40,64}\b/i.test(trimmed)
    || /\bat\s+[^\n]*?\([^\n)]*:\d+(?::\d+)?\)|\bat\s+(?:async\s+)?(?:[^\s():]+\.(?:[cm]?js|[cm]?ts|jsx|tsx)|node:[^\s()]+|(?:file|https?):\/\/[^\s()]+|\/[^\s()]+):\d+(?::\d+)?|Traceback \(most recent call last\)|\bFile ["'][^"']+["'], line \d+/.test(trimmed)
    || /\bthread\s+['"][^'"]+['"]\s+panicked at\b|\bstack backtrace:|(?:^|\n)\s*\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?[A-Za-z_][\w]*(?:::[\w<>]+)+|\bat\s+\S+\.rs:\d+(?::\d+)?/i.test(trimmed)
    || /\{\s*\}|\[\s*\]|[\[{]\s*(?:[\[{]|"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"\s*[,\]]|-?\d+(?:\.\d+)?\s*[,\]]|(?:true|false|null)\s*[,\]])/.test(trimmed)
  ) {
    throw voiceError('VOICE_CLAUSE_RAW_PAYLOAD_REFUSED', 400)
  }
  const urgency = input.urgency === undefined ? 'normal' : input.urgency
  if (!['normal', 'immediate'].includes(urgency)) {
    throw voiceError('VOICE_CLAUSE_URGENCY_INVALID', 400)
  }
  const interruptible = input.interruptible === undefined ? true : input.interruptible
  if (typeof interruptible !== 'boolean') {
    throw voiceError('VOICE_CLAUSE_INTERRUPTIBLE_INVALID', 400)
  }
  const voiceId = input.voiceId === undefined
    ? DEFAULT_VOICE
    : (typeof input.voiceId === 'string' && VOICE_SET.has(input.voiceId) ? input.voiceId : null)
  if (!voiceId) throw voiceError('VOICE_ID_UNSUPPORTED', 400)
  return Object.freeze({
    schema: VOICE_CLAUSE_SCHEMA,
    mode: 'forced_text_stream',
    allowSubstantiveGeneration: false,
    turnId,
    clauseId,
    voiceId,
    text: trimmed,
    urgency,
    interruptible,
  })
}

/** Compile and bound the ~300-token (`<= 1200` UTF-8 bytes) `CURRENT_STATE` attention-sink slot. */
export function compileVoiceStateSlot(input = {}) {
  if (!isObject(input)) throw voiceError('VOICE_STATE_SLOT_INVALID', 400)
  const topic = typeof input.topic === 'string' ? boundedSummary(input.topic, 320) : ''
  const epoch = Number.isSafeInteger(input.epoch) && input.epoch >= 0 ? input.epoch : null
  const ballId = typeof input.ballId === 'string' && HEX_64.test(input.ballId) ? input.ballId.slice(0, 12) : null
  const activeWish = typeof input.activeWish === 'string' ? boundedSummary(input.activeWish, 240) : ''
  const openThreads = Array.isArray(input.openThreads)
    ? input.openThreads
      .filter(item => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 6)
      .map(item => boundedSummary(item, 120))
    : []

  const lines = [
    '[CURRENT_STATE — GROUNDED SUMMARY ONLY; NEVER INVENT FACTS; BACKCHANNEL UNTIL AGENT CLAUSE ARRIVES]',
    ...(epoch !== null ? [`head: epoch ${String(epoch)}${ballId ? ` (${ballId})` : ''}`] : []),
    ...(topic ? [`topic: ${topic}`] : []),
    ...(activeWish ? [`active_wish: ${activeWish}`] : []),
    ...(openThreads.length > 0 ? [`open_threads: ${openThreads.join(' | ')}`] : []),
  ]
  let slotText = lines.join('\n')
  let encoded = encoder.encode(slotText)
  if (encoded.byteLength > VOICE_STATE_MAX_BYTES) {
    // Exclude a partial final code point; decoding arbitrary byte slices can throw.
    let end = VOICE_STATE_MAX_BYTES - 3
    while ((encoded[end] & 0xc0) === 0x80) end -= 1
    slotText = new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end)) + '...'
    encoded = encoder.encode(slotText)
  }
  return Object.freeze({
    schema: VOICE_STATE_SLOT_SCHEMA,
    byteLength: encoded.byteLength,
    maxBytes: VOICE_STATE_MAX_BYTES,
    slotText,
  })
}

async function readBoundedVoiceJson(request, maxBytes = 16384) {
  const reader = request.body?.getReader()
  if (!reader) throw voiceError('VOICE_REQUEST_INVALID', 400)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw voiceError('REQUEST_BODY_TOO_LARGE', 413)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof TypeError) throw voiceError('VOICE_JSON_INVALID', 400)
    throw error
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(text)
  } catch {
    throw voiceError('VOICE_JSON_INVALID', 400)
  }
}

async function callHeadTurnJournal(env, seedId, payload) {
  if (!env?.HEAD || !HEX_64.test(seedId ?? '')) throw voiceError('BOOTSTRAP_REQUIRED', 503)
  const stub = env.HEAD.get(env.HEAD.idFromName('node-main-v1'))
  const response = await stub.fetch(new Request('https://x61.internal/_head/turn-journal', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-x6-internal-authorized': '1',
      'x-x6-bootstrap-seed': seedId,
    },
    body: JSON.stringify(payload),
  }))
  const parsed = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok && parsed?.ok === true, body: parsed }
}

/** Handle voice control and the fail-closed renderer bridge. Speech passes require a verified
 * owner, same-origin browser request, durable rate reservation and explicitly supplied transport.
 * Provider failures retain the durable reservation and return fixed error codes, never upstream bodies.
 * @param {object} options Request, environment, bootstrap seed, verified access, trusted transport and optional clock.
 * @returns {Promise<Response>} No-store response; grants contain ok, provider, accessToken and expiresInSeconds only.
 */
export async function handleEdgeVoiceRequest({ request, url, env, seedId, access, networkFetch, now = Date.now }) {
  const json = (value, status = 200) => Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })

  if (url.pathname === '/door/voice') {
    if (url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
    const voiceParam = url.searchParams.get('voice') ?? undefined
    const defaultVoice = projectVoiceStatus(env).defaultVoice
    const voiceId = voiceParam === undefined ? defaultVoice : (VOICE_SET.has(voiceParam) ? voiceParam : null)
    if (!voiceId) return json({ ok: false, code: 'VOICE_ID_UNSUPPORTED' }, 400)
    const turnIdParam = url.searchParams.get('turnId')
    if (turnIdParam !== null && !TURN_ID_RE.test(turnIdParam)) {
      return json({ ok: false, code: 'VOICE_TURN_ID_INVALID' }, 400)
    }
    for (const key of url.searchParams.keys()) {
      if (key !== 'voice' && key !== 'turnId') return json({ ok: false, code: 'VOICE_QUERY_INVALID' }, 400)
    }
    const upstreamBase = validRendererWsUrl(env?.PERSONAPLEX_WS_URL, env)
    if (!upstreamBase) {
      return json({
        ok: false,
        code: 'VOICE_RENDERER_UNCONFIGURED',
        protocol: VOICE_DIRECTOR_PROTOCOL,
        voiceId,
        voiceAuthority: 'none',
      }, 503)
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ ok: false, code: 'WEBSOCKET_UPGRADE_REQUIRED' }, 426)
    }
    // Raw PersonaPlex sockets do not provide a verified forced-text/idle frame protocol.
    // Do not expose an autonomous renderer or forward client audio without a Head-owned
    // journaled session and enforced per-frame directives. Configuration is not capability.
    return json({
      ok: false,
      code: 'VOICE_RENDERER_PROTOCOL_UNSUPPORTED',
      bridgeAvailable: false,
      voiceAuthority: 'none',
    }, 503)
  }

  if (url.pathname !== '/_host/voice') {
    return json({ ok: false, code: 'NOT_FOUND' }, 404)
  }
  if (url.search || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
  if (request.method === 'GET') {
    return json({ ok: true, ...projectVoiceStatus(env) })
  }
  if (request.method !== 'POST') {
    return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
  }

  const input = await readBoundedVoiceJson(request)
  if (!isObject(input) || typeof input.action !== 'string') {
    return json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400)
  }

  if (ELEVEN_SPEECH_ACTIONS.includes(input.action)) return await handleElevenSpeech({ request, url, env, seedId, access, networkFetch, now, input }) // VOICE hook
  if (input.action === 'speech_pass') {
    const at = now()
    if (access?.type !== 'owner' || typeof access.email !== 'string' || access.email.length > 254
      || !/^[^\s@]+@[^\s@]+$/.test(access.email) || typeof env?.OWNER_EMAIL !== 'string'
      || access.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
      || !Number.isFinite(access.expires) || !Number.isFinite(at) || access.expires <= at / 1000) {
      return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
    }
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') {
      return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
    }
    const apiKey = typeof env?.DEEPGRAM_API_KEY === 'string' ? env.DEEPGRAM_API_KEY.trim() : ''
    if (!apiKey) return json({ ok: false, code: 'SPEECH_PROVIDER_UNCONFIGURED' }, 503)
    if (typeof networkFetch !== 'function' || !env.HEAD || !HEX_64.test(seedId ?? '')) {
      return json({ ok: false, code: 'SPEECH_PROVIDER_UNAVAILABLE' }, 503)
    }
    try {
      return json({ ...await mintSpeechPass(request, apiKey, networkFetch, env, seedId, access), ...herVoiceField(env) }) // VOICE hook
    } catch (error) {
      if (error?.code === 'SPEECH_PASS_RATE_LIMITED') {
        const response = json({ ok: false, code: error.code }, 429)
        response.headers.set('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
        return response
      }
      const code = ['SPEECH_PROVIDER_TIMEOUT', 'SPEECH_REQUEST_CANCELLED', 'SPEECH_PASS_BUDGET_UNAVAILABLE'].includes(error?.code)
        ? error.code : 'SPEECH_PROVIDER_FAILED'
      return json({ ok: false, code }, code === 'SPEECH_PROVIDER_TIMEOUT' ? 504 : code === 'SPEECH_REQUEST_CANCELLED' ? 499 : code === 'SPEECH_PASS_BUDGET_UNAVAILABLE' ? 503 : 502)
    }
  }

  if (input.action === 'validate_clause') {
    const directive = validateSpeakableClause(input.clause ?? null)
    return json({ ok: true, action: 'validate_clause', directive })
  }

  if (input.action === 'compile_state_slot') {
    const slot = compileVoiceStateSlot(input.state ?? {})
    return json({ ok: true, action: 'compile_state_slot', slot })
  }

  if (input.action === 'dispatch_turn') {
    const turnId = typeof input.turnId === 'string' && TURN_ID_RE.test(input.turnId) ? input.turnId : null
    if (!turnId) return json({ ok: false, code: 'VOICE_TURN_ID_INVALID' }, 400)
    const transcript = typeof input.transcript === 'string' ? input.transcript.trim() : ''
    if (!transcript || transcript.length > VOICE_TRANSCRIPT_MAX_CHARS) {
      return json({ ok: false, code: 'VOICE_TRANSCRIPT_INVALID' }, 400)
    }
    const defaultVoice = projectVoiceStatus(env).defaultVoice
    const voiceId = input.voiceId === undefined
      ? defaultVoice
      : (typeof input.voiceId === 'string' && VOICE_SET.has(input.voiceId) ? input.voiceId : null)
    if (!voiceId) return json({ ok: false, code: 'VOICE_ID_UNSUPPORTED' }, 400)
    // Explicitly ignore any caller-supplied owner/authority flags: speech NEVER grants authority.
    const canonicalEnvelope = JSON.stringify({
      protocol: VOICE_DIRECTOR_PROTOCOL,
      turnId,
      voiceId,
      transcript,
      voiceAuthority: 'none',
    })
    const requestSha256 = await sha256Hex(canonicalEnvelope)
    const utteranceSha256 = await sha256Hex(transcript)
    const journal = await callHeadTurnJournal(env, seedId, {
      turnId,
      provider: 'personaplex-voice',
      endpoint: '/_host/voice/dispatch',
      requestedModel: 'nvidia/personaplex-7b-v1',
      requestSha256,
      utteranceSha256,
      utterancePreview: transcript.slice(0, 280),
      utteranceBytes: encoder.encode(transcript).byteLength,
      modality: 'voice',
      voiceId,
    })
    if (!journal.ok) {
      return json({
        ok: false,
        code: journal.body?.code ?? 'VOICE_JOURNAL_FAILED',
        turnId,
      }, journal.status >= 400 ? journal.status : 503)
    }
    return json({
      ok: true,
      action: 'dispatch_turn',
      protocol: VOICE_DIRECTOR_PROTOCOL,
      turnId,
      voiceId,
      savedBeforeDispatch: true,
      idempotent: Boolean(journal.body?.idempotent),
      journalSeq: journal.body?.entry?.seq ?? null,
      requestSha256,
      utteranceSha256,
      signerRole: 'voice-transcript-unconfirmed',
      voiceAuthority: 'none',
      ownerAuthorityGranted: false,
    })
  }

  if (input.action === 'barge_in' || input.action === 'turn_abandon') {
    const turnId = typeof input.turnId === 'string' && TURN_ID_RE.test(input.turnId) ? input.turnId : null
    if (!turnId) return json({ ok: false, code: 'VOICE_TURN_ID_INVALID' }, 400)
    const cancelled = await callHeadTurnJournal(env, seedId, {
      action: 'cancel',
      turnId,
      reason: input.action,
    })
    if (!cancelled.ok) {
      return json({
        ok: false,
        code: cancelled.body?.code ?? 'VOICE_CANCEL_FAILED',
        turnId,
      }, cancelled.status >= 400 ? cancelled.status : 503)
    }
    return json({
      ok: true,
      action: input.action,
      turnId,
      cancelled: true,
      reason: input.action,
      activeTurnCancelled: Boolean(cancelled.body?.activeTurnCancelled),
      idleDirective: idleVoiceDirective(),
    })
  }

  return json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400)
}
