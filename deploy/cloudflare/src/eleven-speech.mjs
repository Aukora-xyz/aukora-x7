/** Her ElevenLabs voice at the edge: a single-use speech pass, the day's usage, and how many passes the day allows.
 *
 * WHAT THIS MODULE DOES. Auma Live speaks in the owner's ElevenLabs voice (apps/web/public/app/elevenlabs-voice.js). The
 * page never holds the account key: it asks `POST /_host/voice` with one of three actions, which voice-director.mjs hands
 * here.
 *   speech_pass_tts    a pass ElevenLabs accepts once, for fifteen minutes, on its text-to-speech socket
 *                      (`POST https://api.elevenlabs.io/v1/single-use-token/tts_websocket`, the key in the request header),
 *                      with the voice id, the pass's reservation and the day's usage.
 *   speech_extend      one further slice for the same pass, under the same owner, origin, rate and ceiling checks as a
 *                      pass (no provider call): the page never sends a character its reservation does not cover.
 *   speech_usage       the page's own report against one reservation: the CUMULATIVE characters sent on that pass so
 *                      far and a sequence number, plus turns, time to first audio and errors by kind since its last
 *                      report, and whether the pass's socket is finished. It can only add.
 *   speech_usage_read  today's record and the limits.
 * All four are owner-only and same-origin. None of them permits anything: they mint a speech credential and add to a
 * count. Voice carries no authority (voice-director.mjs, `voiceAuthority: none`).
 *
 * WHETHER HER VOICE IS SET UP rides on the answer the page already receives: Deepgram's `speech_pass` answer gains one
 * field, `herVoice` (`herVoiceField` below), and only when one of the two settings is present at all; with neither, that
 * answer is byte for byte what it was before this module existed.
 *
 * GATES, IN ORDER, before anything about configuration is said: the verified owner (the same test as `speech_pass`), a
 * same-origin browser request, then the settings (named when missing), then HEAD and the network transport, then the
 * ledger, then the provider call. The ledger and the provider share ONE 5-second deadline; the provider's redirects are
 * refused, its body is read to 8 KiB at most, and only fixed error codes are answered, never an upstream body.
 *
 * WHAT BOUNDS SPENDING, HONESTLY. The hard cap is the provider's own usage limit on the API key, which the owner sets when
 * he creates the key; this edge cannot know it and never names a number for it. What this edge bounds is how many passes
 * it hands out a day: RESERVE, THEN SETTLE. Each pass reserves a fixed slice of the day's characters
 * (ELEVENLABS_CHARS_PER_PASS) BEFORE it is given, and each extension one more; the page's reports settle the reservation
 * down to what was spoken, a reservation never settled stays fully counted, and a report larger than its reservation is
 * counted in full. REPORTS ARE CUMULATIVE AND IDEMPOTENT: each carries the pass's total so far and a sequence number;
 * the ledger keeps the largest total it has seen for that pass and ignores an older or repeated report, so a lost report
 * loses nothing (the next carries the truth); a final settles at the larger of its total and the largest seen, and only
 * then releases the rest. A pass is refused when the counted
 * total plus a new slice would pass ELEVENLABS_MAX_CHARS_PER_DAY, or its estimate (characters / 1000 x
 * ELEVENLABS_PRICE_PER_1K_CHARS) would pass ELEVENLABS_MAX_COST_PER_DAY, and beyond six passes and extensions a minute. A
 * ceiling refusal carries the edge's own `day` and `resetInSeconds` (until the end of that UTC day by the edge's clock),
 * so the page keeps no calendar of its own. A pass is extended only on the edge's day it was reserved in: an extension
 * after the edge's midnight is refused as ELEVEN_SPEECH_PASS_DAY_ENDED (409, never a ceiling, nothing written), so no
 * pass charges a day that has ended; its report still settles there, and the page asks a new pass. What one pass can
 * spend is the provider's limit, not this edge's: the reports are the page's own count.
 *
 * THE LEDGER LIVES IN HEAD (`/_head/eleven-speech`, `handleElevenSpeechHeadRoute` below), the only durable counter the
 * Worker has. One key per UTC day `{chars, mints, turns, firstAudio:{count,sumMs,maxMs}, errors, open}` (`open`: the
 * reservations not yet settled, `{slice, used, seq}` each: characters reserved, the largest total reported, the latest
 * sequence number) and one key for the mints of the rolling minute, all under
 * `head:eleven-speech:v1:`; no other key is read or written. A setting unset or empty takes its default; `0` for a
 * ceiling refuses always (the off switch); anything that is not a plain non-negative decimal refuses, naming the setting.
 * A ledger that cannot be read refuses (503), never opens.
 */

export const ELEVEN_SPEECH_ACTIONS = Object.freeze(['speech_pass_tts', 'speech_extend', 'speech_usage', 'speech_usage_read'])
export const ELEVEN_SPEECH_HEAD_ROUTE = '/_head/eleven-speech'
export const ELEVEN_MODEL_ID = 'eleven_flash_v2_5'
export const ELEVEN_TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/tts_websocket'
/** `unconfirmed`: a phrase ended by the quiet backstop, not by ElevenLabs' final for it (not counted as completed). */
export const ELEVEN_ERROR_KINDS = Object.freeze(['mint', 'open', 'first_audio', 'closed', 'ceiling', 'unconfirmed'])
export const ELEVEN_LIMIT_DEFAULTS = Object.freeze({
  ELEVENLABS_MAX_CHARS_PER_DAY: 100000,
  ELEVENLABS_MAX_COST_PER_DAY: 4,
  ELEVENLABS_PRICE_PER_1K_CHARS: 0.04,
  ELEVENLABS_CHARS_PER_PASS: 5000,
})
/** Passes and extensions together, per rolling minute. */
export const ELEVEN_MINTS_PER_MINUTE = 6
/** The largest sequence number a report may carry. */
export const ELEVEN_SEQ_MAX = 1000000000
/** Reservations a day may hold open at once; the next pass waits until one settles. */
export const ELEVEN_OPEN_RESERVATIONS_MAX = 64
export const ELEVEN_DEADLINE_MS = 5000
/** A reserved pass that was never given is released within this long, or stays counted. */
export const ELEVEN_RELEASE_MS = 2000
export const ELEVEN_GRANT_MAX_BYTES = 8192
export const ELEVEN_USAGE_LIMITS = Object.freeze({ turns: 10000, firstAudioMs: 60000, errorsPerKind: 10000 })
export const ELEVEN_SETTING_NAMES = Object.freeze(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'])

const KEY_PREFIX = 'head:eleven-speech:v1:'
const RATE_KEY = `${KEY_PREFIX}mints`
const HEX_64 = /^[0-9a-f]{64}$/
const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const PASS_RE = /^[A-Za-z0-9._~-]{8,512}$/
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const RESERVATION_RE = /^\d{4}-\d{2}-\d{2}\.[1-9][0-9]{0,6}$/
const HEAD_BODY_MAX_BYTES = 1024
const HEAD_ANSWER_MAX_BYTES = 8192
const SLICE_MAX = 1000000
const DAY_MS = 86400000
const LIMIT_NAMES = Object.freeze({ maxChars: 'ELEVENLABS_MAX_CHARS_PER_DAY', maxCost: 'ELEVENLABS_MAX_COST_PER_DAY',
  pricePer1k: 'ELEVENLABS_PRICE_PER_1K_CHARS', slice: 'ELEVENLABS_CHARS_PER_PASS' })
const CEILING_SETTINGS = Object.freeze([LIMIT_NAMES.maxChars, LIMIT_NAMES.maxCost])
const LIMIT_FIELDS = Object.freeze(['maxChars', 'maxCost', 'pricePer1k', 'slice'])

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isCount = value => Number.isSafeInteger(value) && value >= 0
const hasExactly = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const addCount = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b)
const coded = (code, status, extra = {}) => Object.assign(new Error(code), { code, status, ...extra })
const dayOf = at => new Date(at).toISOString().slice(0, 10)
/** Seconds from `at` until the end of the UTC day `day`, by the edge's clock (0 once it has ended). */
export const resetInSecondsFor = (day, at) => Math.max(0, Math.ceil((Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - at) / 1000))
const validReset = value => Number.isSafeInteger(value) && value >= 0 && value <= DAY_MS / 1000

function ownerAccess(access, ownerEmail, at) {
  return access?.type === 'owner' && typeof access.email === 'string' && access.email.length <= 254
    && /^[^\s@]+@[^\s@]+$/.test(access.email) && typeof ownerEmail === 'string'
    && access.email.toLowerCase() === ownerEmail.toLowerCase()
    && Number.isFinite(access.expires) && Number.isFinite(at) && access.expires > at / 1000
}

/** The two settings her voice needs that are missing, by name (a voice id that cannot go in a URL path is missing). */
export function missingElevenSettings(env) {
  const apiKey = typeof env?.ELEVENLABS_API_KEY === 'string' ? env.ELEVENLABS_API_KEY.trim() : ''
  const voiceId = typeof env?.ELEVENLABS_VOICE_ID === 'string' ? env.ELEVENLABS_VOICE_ID.trim() : ''
  return [...(apiKey ? [] : ['ELEVENLABS_API_KEY']), ...(VOICE_ID_RE.test(voiceId) ? [] : ['ELEVENLABS_VOICE_ID'])]
}

/**
 * The one field Deepgram's `speech_pass` answer gains, so the page learns from an answer it already receives whether her
 * voice is set up. With NEITHER setting present (the deployed state before anyone sets one) it is nothing at all, so that
 * answer stays byte for byte what it was. Only ever added to an answer the owner gate has already let through.
 * @param {object} env The Worker environment.
 * @returns {{}|{herVoice: {configured: true}|{configured: false, missing: string[]}}} what to spread into the answer.
 */
export function herVoiceField(env) {
  const present = ELEVEN_SETTING_NAMES.some(name => typeof env?.[name] === 'string' && env[name].trim() !== '')
  if (!present) return {}
  const missing = missingElevenSettings(env)
  return { herVoice: missing.length === 0 ? { configured: true } : { configured: false, missing } }
}

/** The four limits, from `[vars]`. @returns {{ok:true, limits:object}|{ok:false, setting:string}} */
export function readElevenLimits(env) {
  const limits = {}
  for (const [field, name] of Object.entries(LIMIT_NAMES)) {
    const raw = env?.[name]
    if (raw === undefined || raw === null || raw === '') { limits[field] = ELEVEN_LIMIT_DEFAULTS[name]; continue }
    if (typeof raw !== 'string' || !DECIMAL_RE.test(raw) || raw.length > 32) return { ok: false, setting: name }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) return { ok: false, setting: name }
    // A slice is a whole, positive number of characters: a slice of nothing would let passes out unreserved.
    if (field === 'slice' && (!Number.isSafeInteger(value) || value < 1 || value > SLICE_MAX)) return { ok: false, setting: name }
    limits[field] = value
  }
  return { ok: true, limits }
}

const emptyRecord = () => ({ chars: 0, mints: 0, turns: 0, firstAudio: { count: 0, sumMs: 0, maxMs: 0 },
  errors: Object.fromEntries(ELEVEN_ERROR_KINDS.map(kind => [kind, 0])), open: {} })

/** A day's record as HEAD stores it, checked whole. */
export function validElevenRecord(record) {
  return hasExactly(record, ['chars', 'mints', 'turns', 'firstAudio', 'errors', 'open'])
    && isCount(record.chars) && isCount(record.mints) && isCount(record.turns)
    && hasExactly(record.firstAudio, ['count', 'sumMs', 'maxMs'])
    && isCount(record.firstAudio.count) && isCount(record.firstAudio.sumMs) && isCount(record.firstAudio.maxMs)
    && hasExactly(record.errors, [...ELEVEN_ERROR_KINDS]) && ELEVEN_ERROR_KINDS.every(kind => isCount(record.errors[kind]))
    && isObject(record.open) && Object.keys(record.open).length <= ELEVEN_OPEN_RESERVATIONS_MAX
    && Object.entries(record.open).every(([id, entry]) => RESERVATION_RE.test(id) && hasExactly(entry, ['slice', 'used', 'seq'])
      && Number.isSafeInteger(entry.slice) && entry.slice >= 1 && isCount(entry.used) && isCount(entry.seq) && entry.seq <= ELEVEN_SEQ_MAX)
}

/** What the day counts: every character reported, plus what each open reservation has not yet spoken of its slice. */
export function countedChars(record) {
  let counted = record.chars
  for (const entry of Object.values(record.open)) counted = addCount(counted, Math.max(0, entry.slice - entry.used))
  return counted
}

/** The estimate, computed on read. */
const estimate = (chars, limits) => Math.round(chars / 1000 * limits.pricePer1k * 10000) / 10000

/** Whether a new slice would pass a ceiling, and which one. `0` refuses always. */
function ceilingFor(counted, limits) {
  const next = counted + limits.slice
  if (limits.maxChars === 0 || next > limits.maxChars) return LIMIT_NAMES.maxChars
  if (limits.maxCost === 0 || next / 1000 * limits.pricePer1k > limits.maxCost + 1e-9) return LIMIT_NAMES.maxCost
  return null
}

const validFirstAudio = value => hasExactly(value, ['count', 'sumMs', 'maxMs'])
  && isCount(value.count) && value.count <= ELEVEN_USAGE_LIMITS.turns
  && isCount(value.maxMs) && value.maxMs <= ELEVEN_USAGE_LIMITS.firstAudioMs
  && isCount(value.sumMs) && value.sumMs <= value.count * ELEVEN_USAGE_LIMITS.firstAudioMs
  && (value.count > 0 || (value.sumMs === 0 && value.maxMs === 0))

/**
 * A usage report from the page, or null when it is not one. `chars` is the pass's CUMULATIVE total so far and `seq` its
 * sequence number; it can only add; its characters are counted in full (no clamp: a report larger than its reservation
 * counts whole). A report with no reservation carries no characters.
 */
export function readElevenUsageReport(input) {
  if (!hasExactly(input, ['action', 'reservation', 'seq', 'chars', 'turns', 'firstAudio', 'errors', 'final']) || input.action !== 'speech_usage') return null
  if (input.reservation !== null && (typeof input.reservation !== 'string' || !RESERVATION_RE.test(input.reservation))) return null
  if (!Number.isSafeInteger(input.seq) || input.seq < 1 || input.seq > ELEVEN_SEQ_MAX) return null
  if (!isCount(input.chars) || !isCount(input.turns) || input.turns > ELEVEN_USAGE_LIMITS.turns || typeof input.final !== 'boolean') return null
  if (input.reservation === null && (input.chars !== 0 || input.final)) return null
  if (!validFirstAudio(input.firstAudio)) return null
  if (!isObject(input.errors) || Object.keys(input.errors).length > ELEVEN_ERROR_KINDS.length) return null
  for (const [kind, value] of Object.entries(input.errors)) {
    if (!ELEVEN_ERROR_KINDS.includes(kind) || !isCount(value) || value > ELEVEN_USAGE_LIMITS.errorsPerKind) return null
  }
  return { reservation: input.reservation, seq: input.seq, chars: input.chars, turns: input.turns, firstAudio: { ...input.firstAudio },
    errors: { ...input.errors }, final: input.final }
}

// ---- the Worker side ----

/** Run `work` under one deadline, cancelled with the caller's request. */
async function underDeadline(request, work) {
  const controller = new AbortController()
  const deadlineAt = performance.now() + ELEVEN_DEADLINE_MS
  let stopped = null, rejectDeadline, timer
  const readers = new Set()
  const deadline = new Promise((_, reject) => { rejectDeadline = reject })
  const cancel = (error) => {
    if (stopped) return
    stopped = error
    rejectDeadline(error)
    controller.abort()
    for (const reader of readers) void reader.cancel().catch(_error => {})
  }
  const onAbort = () => cancel(coded('ELEVEN_SPEECH_REQUEST_CANCELLED', 499))
  const check = () => {
    if (request.signal.aborted) onAbort()
    if (performance.now() >= deadlineAt) cancel(coded('ELEVEN_SPEECH_PROVIDER_TIMEOUT', 504))
    if (stopped) throw stopped
  }
  // A JSON body of `maxBytes` at most; anything else is `failure`.
  const readJson = async (response, maxBytes, failure) => {
    const length = response.headers.get('content-length')
    if (stopped || request.signal.aborted || performance.now() >= deadlineAt || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
      || length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      void response.body?.cancel().catch(_error => {})
      check()
      throw failure()
    }
    const reader = response.body?.getReader()
    if (!reader) throw failure()
    readers.add(reader)
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '', size = 0
    try {
      for (;;) {
        check()
        const { done, value } = await reader.read()
        check()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) { void reader.cancel().catch(_error => {}); throw failure() }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) {
      if (error?.code) throw error
      throw failure()
    } finally { readers.delete(reader) }
    try { return JSON.parse(text) } catch { throw failure() }
  }
  request.signal.addEventListener('abort', onAbort, { once: true })
  timer = setTimeout(() => cancel(coded('ELEVEN_SPEECH_PROVIDER_TIMEOUT', 504)), ELEVEN_DEADLINE_MS)
  try {
    return await Promise.race([deadline, (async () => { check(); return await work({ signal: controller.signal, check, readJson }) })()])
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
  }
}

/** One operation on the HEAD ledger. Any answer that is not exactly understood is a ledger that cannot be read. */
async function ledger({ env, seedId, access, signal, check, readJson }, body) {
  const unavailable = () => coded('ELEVEN_SPEECH_LEDGER_UNAVAILABLE', 503)
  let response, answer
  try {
    response = await env.HEAD.get(env.HEAD.idFromName('node-main-v1')).fetch(new Request(`https://x61.internal${ELEVEN_SPEECH_HEAD_ROUTE}`, {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId,
        'x-x6-verified-access': JSON.stringify({ type: access.type, email: access.email, expires: access.expires }),
      },
      body: JSON.stringify(body),
    }))
    answer = await readJson(response, HEAD_ANSWER_MAX_BYTES, unavailable)
  } catch (error) {
    check()
    throw error?.code === 'ELEVEN_SPEECH_LEDGER_UNAVAILABLE' ? error : unavailable()
  }
  if (response.status === 429 && answer?.ok === false && answer.code === 'ELEVEN_SPEECH_CEILING' && CEILING_SETTINGS.includes(answer.setting)
    && typeof answer.day === 'string' && DAY_RE.test(answer.day) && validReset(answer.resetInSeconds)) {
    throw coded('ELEVEN_SPEECH_CEILING', 429, { setting: answer.setting, day: answer.day, resetInSeconds: answer.resetInSeconds })
  }
  if (response.status === 429 && answer?.ok === false && answer.code === 'ELEVEN_SPEECH_RATE_LIMITED'
    && Number.isSafeInteger(answer.retryAfterMs) && answer.retryAfterMs > 0 && answer.retryAfterMs <= 60000) {
    throw coded('ELEVEN_SPEECH_RATE_LIMITED', 429, { retryAfterMs: answer.retryAfterMs })
  }
  if (response.status === 429 && answer?.ok === false && answer.code === 'ELEVEN_SPEECH_PASSES_OPEN') throw coded('ELEVEN_SPEECH_PASSES_OPEN', 429)
  if (response.status === 400 && answer?.ok === false && answer.code === 'ELEVEN_SPEECH_USAGE_STALE') throw coded('ELEVEN_SPEECH_USAGE_STALE', 400)
  if (response.status === 409 && answer?.ok === false && answer.code === 'ELEVEN_SPEECH_PASS_DAY_ENDED') throw coded('ELEVEN_SPEECH_PASS_DAY_ENDED', 409)
  if (!response.ok || answer?.ok !== true || typeof answer.day !== 'string' || !DAY_RE.test(answer.day)
    || !validElevenRecord(answer.record) || !isCount(answer.counted)) throw unavailable()
  if (body.op === 'mint' && (typeof answer.reservation !== 'string' || !RESERVATION_RE.test(answer.reservation))) throw unavailable()
  if (body.op === 'extend' && (answer.reservation !== body.reservation || !Number.isSafeInteger(answer.reserved) || answer.reserved < 1)) throw unavailable()
  return answer
}

const usageView = (day, record, counted, limits) => ({ day, chars: record.chars, counted, maxChars: limits.maxChars,
  cost: estimate(record.chars, limits), maxCost: limits.maxCost, pricePer1k: limits.pricePer1k, slice: limits.slice })

/**
 * The four ElevenLabs actions of `POST /_host/voice` (voice-director.mjs hands them here).
 * @param {object} options Request, URL, environment, bootstrap seed, verified access, network transport, clock and the
 * already-read JSON input.
 * @returns {Promise<Response>} no-store; a pass answer carries ok, provider, pass, voiceId, modelId, reservation and usage only;
 * an extension answer ok, action, reservation, reserved (the pass's whole reservation now) and usage only.
 */
export async function handleElevenSpeech({ request, url, env, seedId, access, networkFetch, now = Date.now, input }) {
  const json = (value, status = 200) => Response.json(value, {
    status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })
  if (!ownerAccess(access, env?.OWNER_EMAIL, now())) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') {
    return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
  }
  const failed = (error) => {
    if (error?.code === 'ELEVEN_SPEECH_CEILING') {
      return json({ ok: false, code: error.code, setting: error.setting, day: error.day, resetInSeconds: error.resetInSeconds }, 429)
    }
    if (error?.code === 'ELEVEN_SPEECH_RATE_LIMITED') {
      const response = json({ ok: false, code: error.code }, 429)
      response.headers.set('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))))
      return response
    }
    const statuses = { ELEVEN_SPEECH_PROVIDER_TIMEOUT: 504, ELEVEN_SPEECH_REQUEST_CANCELLED: 499, ELEVEN_SPEECH_LEDGER_UNAVAILABLE: 503,
      ELEVEN_SPEECH_PASSES_OPEN: 429, ELEVEN_SPEECH_USAGE_STALE: 400, ELEVEN_SPEECH_PASS_DAY_ENDED: 409 }
    const code = Object.hasOwn(statuses, error?.code ?? '') ? error.code : 'ELEVEN_SPEECH_PROVIDER_FAILED'
    return json({ ok: false, code }, statuses[code] ?? 502)
  }
  const reachable = typeof networkFetch === 'function' && Boolean(env?.HEAD) && HEX_64.test(seedId ?? '')

  if (input.action === 'speech_usage') {
    const report = readElevenUsageReport(input)
    if (!report) return json({ ok: false, code: 'ELEVEN_SPEECH_USAGE_INVALID' }, 400)
    if (!env?.HEAD || !HEX_64.test(seedId ?? '')) return json({ ok: false, code: 'ELEVEN_SPEECH_UNAVAILABLE' }, 503)
    try {
      await underDeadline(request, tools => ledger({ env, seedId, access, ...tools }, { op: 'usage', ...report }))
      return json({ ok: true, action: 'speech_usage' })
    } catch (error) { return failed(error) }
  }

  const limitsRead = readElevenLimits(env)
  if (input.action === 'speech_usage_read') {
    if (!env?.HEAD || !HEX_64.test(seedId ?? '')) return json({ ok: false, code: 'ELEVEN_SPEECH_UNAVAILABLE' }, 503)
    try {
      const answer = await underDeadline(request, tools => ledger({ env, seedId, access, ...tools }, { op: 'read' }))
      const { record } = answer
      return json({ ok: true, action: 'speech_usage_read', day: answer.day,
        usage: { ...record, counted: answer.counted, cost: limitsRead.ok ? estimate(record.chars, limitsRead.limits) : null },
        limits: limitsRead.ok ? { ...limitsRead.limits } : null, ...(limitsRead.ok ? {} : { invalidSetting: limitsRead.setting }) })
    } catch (error) { return failed(error) }
  }

  const missing = missingElevenSettings(env)
  if (input.action === 'speech_extend') {
    if (!hasExactly(input, ['action', 'reservation']) || typeof input.reservation !== 'string' || !RESERVATION_RE.test(input.reservation)) {
      return json({ ok: false, code: 'ELEVEN_SPEECH_EXTEND_INVALID' }, 400)
    }
    if (missing.length > 0) return json({ ok: false, code: 'ELEVEN_SPEECH_UNCONFIGURED', missing }, 503)
    if (!limitsRead.ok) return json({ ok: false, code: 'ELEVEN_SPEECH_LIMIT_INVALID', setting: limitsRead.setting }, 503)
    if (!env?.HEAD || !HEX_64.test(seedId ?? '')) return json({ ok: false, code: 'ELEVEN_SPEECH_UNAVAILABLE' }, 503)
    const { limits } = limitsRead
    try {
      const answer = await underDeadline(request, tools => ledger({ env, seedId, access, ...tools }, { op: 'extend', reservation: input.reservation, limits }))
      return json({ ok: true, action: 'speech_extend', reservation: answer.reservation, reserved: answer.reserved,
        usage: usageView(answer.day, answer.record, answer.counted, limits) })
    } catch (error) { return failed(error) }
  }

  // speech_pass_tts
  if (missing.length > 0) return json({ ok: false, code: 'ELEVEN_SPEECH_UNCONFIGURED', missing }, 503)
  const apiKey = env.ELEVENLABS_API_KEY.trim()
  const voiceId = env.ELEVENLABS_VOICE_ID.trim()
  if (!limitsRead.ok) return json({ ok: false, code: 'ELEVEN_SPEECH_LIMIT_INVALID', setting: limitsRead.setting }, 503)
  if (!reachable) return json({ ok: false, code: 'ELEVEN_SPEECH_UNAVAILABLE' }, 503)
  const { limits } = limitsRead
  let reserved = null
  try {
    return json(await underDeadline(request, async (tools) => {
      const answer = await ledger({ env, seedId, access, ...tools }, { op: 'mint', limits })
      reserved = answer.reservation
      tools.check()
      const providerFailed = () => coded('ELEVEN_SPEECH_PROVIDER_FAILED', 502)
      let response
      try {
        response = await networkFetch(ELEVEN_TOKEN_URL, { method: 'POST', redirect: 'error', signal: tools.signal, headers: { 'xi-api-key': apiKey } })
      } catch (_error) {
        tools.check()
        throw providerFailed()
      }
      if (!response.ok) {
        void response.body?.cancel().catch(_error => {})
        tools.check()
        throw providerFailed()
      }
      const parsed = await tools.readJson(response, ELEVEN_GRANT_MAX_BYTES, providerFailed)
      if (!isObject(parsed) || typeof parsed.token !== 'string' || !PASS_RE.test(parsed.token) || parsed.token.includes(apiKey)) throw providerFailed()
      tools.check()
      const given = reserved
      reserved = null
      return { ok: true, provider: 'elevenlabs', pass: parsed.token, voiceId, modelId: ELEVEN_MODEL_ID, reservation: given,
        usage: usageView(answer.day, answer.record, answer.counted, limits) }
    }))
  } catch (error) {
    // A pass that was reserved and never given is released, best effort: if the release fails too, the slice stays
    // counted, which errs on the side of spending less.
    if (reserved !== null) await releaseReservation({ env, seedId, access }, reserved)
    return failed(error)
  }
}

async function releaseReservation({ env, seedId, access }, reservation) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ELEVEN_RELEASE_MS)
    try {
      const response = await env.HEAD.get(env.HEAD.idFromName('node-main-v1')).fetch(new Request(`https://x61.internal${ELEVEN_SPEECH_HEAD_ROUTE}`, {
        method: 'POST', signal: controller.signal,
        headers: {
          'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId,
          'x-x6-verified-access': JSON.stringify({ type: access.type, email: access.email, expires: access.expires }),
        },
        body: JSON.stringify({ op: 'release', reservation }),
      }))
      void response.body?.cancel().catch(_error => {})
    } finally { clearTimeout(timer) }
  } catch { /* the slice stays counted */ }
}

// ---- the HEAD side ----

async function readBoundedJson(request, maxBytes) {
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel().catch(_error => {}); return undefined }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch { return undefined }
}

const validLimits = limits => hasExactly(limits, LIMIT_FIELDS)
  && LIMIT_FIELDS.every(name => typeof limits[name] === 'number' && Number.isFinite(limits[name]) && limits[name] >= 0)
  && Number.isSafeInteger(limits.slice) && limits.slice >= 1 && limits.slice <= SLICE_MAX

function readLedgerOp(input) {
  if (hasExactly(input, ['op', 'limits']) && input.op === 'mint' && validLimits(input.limits)) return { kind: 'mint', limits: input.limits }
  if (hasExactly(input, ['op']) && input.op === 'read') return { kind: 'read' }
  if (hasExactly(input, ['op', 'reservation']) && input.op === 'release' && typeof input.reservation === 'string'
    && RESERVATION_RE.test(input.reservation)) return { kind: 'release', reservation: input.reservation }
  if (hasExactly(input, ['op', 'reservation', 'limits']) && input.op === 'extend' && typeof input.reservation === 'string'
    && RESERVATION_RE.test(input.reservation) && validLimits(input.limits)) return { kind: 'extend', reservation: input.reservation, limits: input.limits }
  if (isObject(input) && input.op === 'usage') {
    const { op: _op, ...rest } = input
    const report = readElevenUsageReport({ action: 'speech_usage', ...rest })
    if (report && Object.keys(rest).length === 7) return { kind: 'usage', report }
  }
  return null
}

/**
 * HEAD's `/_head/eleven-speech` route: the ledger. It makes every check itself (internal caller, seed, verified owner,
 * shape) and touches only keys under `head:eleven-speech:v1:`.
 * @param {Request} request The Worker's internal request.
 * @param {{url: URL, seedId: string, storage: object, ownerEmail: string, now?: () => number}} context HEAD's facts.
 * @returns {Promise<Response>} the answer; a ledger that cannot be read is 503, never open.
 */
export async function handleElevenSpeechHeadRoute(request, { url, seedId, storage, ownerEmail, now = Date.now }) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const refuse = (code, status, extra = {}) => reply({ ok: false, code, ...extra }, status)
  if (request.headers.get('x-x6-internal-authorized') !== '1') return refuse('UNAUTHORIZED', 401)
  if (request.method !== 'POST') return refuse('METHOD_UNAVAILABLE', 405)
  if (url.href.includes('?') || url.hash) return refuse('NOT_FOUND', 404)
  const seed = request.headers.get('x-x6-bootstrap-seed')
  if (!HEX_64.test(seed ?? '') || seed !== seedId) return refuse('BOOTSTRAP_REQUIRED', 503)
  let access = null
  try { access = JSON.parse(request.headers.get('x-x6-verified-access') ?? 'null') } catch (_error) { access = null }
  const at = now()
  if (!Number.isSafeInteger(at) || at < 0) return refuse('ELEVEN_SPEECH_LEDGER_UNAVAILABLE', 503)
  if (!ownerAccess(access, ownerEmail, at)) return refuse('ELEVEN_SPEECH_OWNER_REQUIRED', 403)
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return refuse('ELEVEN_SPEECH_LEDGER_REQUEST_INVALID', 400)
  const op = readLedgerOp(await readBoundedJson(request, HEAD_BODY_MAX_BYTES))
  if (!op) return refuse('ELEVEN_SPEECH_LEDGER_REQUEST_INVALID', 400)
  const today = dayOf(at)
  // A report settles the day its reservation was made in: today's, or yesterday's (a pass minted before midnight).
  let day = today
  const reservationOf = op.kind === 'usage' ? op.report.reservation : op.kind === 'release' || op.kind === 'extend' ? op.reservation : null
  if (reservationOf !== null) {
    day = reservationOf.slice(0, 10)
    if (day !== today && day !== dayOf(at - 86400000)) return refuse('ELEVEN_SPEECH_USAGE_STALE', 400)
    // A pass reserved before the edge's midnight is never extended after it: an ended day takes no new slice.
    if (op.kind === 'extend' && day !== today) return refuse('ELEVEN_SPEECH_PASS_DAY_ENDED', 409)
  }
  const dayKey = `${KEY_PREFIX}day:${day}`
  try {
    const result = await storage.transaction(async (tx) => {
      const unavailable = { status: 503, body: { ok: false, code: 'ELEVEN_SPEECH_LEDGER_UNAVAILABLE' } }
      const stored = await tx.get(dayKey)
      if (stored !== undefined && !validElevenRecord(stored)) return unavailable
      const record = stored === undefined ? emptyRecord() : structuredClone(stored)
      const answer = extra => ({ status: 200, body: { ok: true, day, record, counted: countedChars(record), ...extra } })
      if (op.kind === 'read') return answer()
      if (op.kind === 'release') {
        // Only a slice nothing was reported against: the pass was reserved and never handed to the page.
        if (record.open[op.reservation]?.used === 0) { delete record.open[op.reservation]; await tx.put(dayKey, record) }
        return answer()
      }
      if (op.kind === 'usage') {
        const { report } = op
        const open = report.reservation === null ? undefined : record.open[report.reservation]
        // A report against a pass that is no longer open (settled, released, or never made) adds nothing: its final
        // already counted the largest total. An older or repeated report on an open pass is ignored, unless it is final.
        if (report.reservation !== null && (!open || (report.seq <= open.seq && !report.final))) return answer()
        // Turns, first audio and errors are what came since the page's last report: they bound nothing.
        if (report.reservation === null || report.seq > open.seq) {
          record.turns = addCount(record.turns, report.turns)
          if (report.firstAudio.count > 0) {
            record.firstAudio.count = addCount(record.firstAudio.count, report.firstAudio.count)
            record.firstAudio.sumMs = addCount(record.firstAudio.sumMs, report.firstAudio.sumMs)
            record.firstAudio.maxMs = Math.max(record.firstAudio.maxMs, report.firstAudio.maxMs)
          }
          for (const [kind, value] of Object.entries(report.errors)) record.errors[kind] = addCount(record.errors[kind], value)
        }
        if (open) {
          // The largest total seen for this pass; a final settles at the larger of its own and that, then releases the rest.
          const total = Math.max(open.used, report.chars)
          record.chars = addCount(record.chars, total - open.used)
          open.used = total
          open.seq = Math.max(open.seq, report.seq)
          if (report.final) delete record.open[report.reservation]
        }
        await tx.put(dayKey, record)
        return answer()
      }
      const { limits } = op
      // An extension is for a pass still open (not settled, not released); a settled pass gets a new pass instead.
      if (op.kind === 'extend' && !record.open[op.reservation]) return { status: 400, body: { ok: false, code: 'ELEVEN_SPEECH_USAGE_STALE' } }
      const setting = ceilingFor(countedChars(record), limits)
      if (setting) return { status: 429, body: { ok: false, code: 'ELEVEN_SPEECH_CEILING', setting, day, resetInSeconds: resetInSecondsFor(day, at) } }
      if (op.kind === 'mint' && Object.keys(record.open).length >= ELEVEN_OPEN_RESERVATIONS_MAX) return { status: 429, body: { ok: false, code: 'ELEVEN_SPEECH_PASSES_OPEN' } }
      const stamps = await tx.get(RATE_KEY)
      if (stamps !== undefined && (!Array.isArray(stamps) || stamps.length > ELEVEN_MINTS_PER_MINUTE
        || !stamps.every((stamp, index) => Number.isSafeInteger(stamp) && stamp >= 0 && stamp <= at && (index === 0 || stamp >= stamps[index - 1])))) {
        return unavailable
      }
      const recent = (stamps ?? []).filter(stamp => at - stamp < 60000)
      if (recent.length >= ELEVEN_MINTS_PER_MINUTE) {
        return { status: 429, body: { ok: false, code: 'ELEVEN_SPEECH_RATE_LIMITED', retryAfterMs: 60000 - (at - recent[0]) } }
      }
      recent.push(at)
      if (op.kind === 'extend') {
        const open = record.open[op.reservation]
        const reserved = open.slice + limits.slice
        if (!Number.isSafeInteger(reserved)) return unavailable
        open.slice = reserved
        await tx.put(RATE_KEY, recent)
        await tx.put(dayKey, record)
        return answer({ reservation: op.reservation, reserved })
      }
      record.mints = addCount(record.mints, 1)
      const reservation = `${day}.${String(record.mints)}`
      if (!RESERVATION_RE.test(reservation)) return unavailable
      record.open[reservation] = { slice: limits.slice, used: 0, seq: 0 }
      await tx.put(RATE_KEY, recent)
      await tx.put(dayKey, record)
      return answer({ reservation })
    })
    return reply(result.body, result.status)
  } catch (_error) {
    return refuse('ELEVEN_SPEECH_LEDGER_UNAVAILABLE', 503)
  }
}
