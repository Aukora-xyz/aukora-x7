/** The VoiceBridge's Worker side: the switch, the owner door, and the two socket doors' checks before the object.
 *
 * The provider owns the audio; her own governed session writes the words. One Durable Object for the world
 * (voice-bridge-do.mjs) holds the provider socket and the owner's tab socket of each live conversation. Three doors:
 *   1. the owner door  POST /_host/voice {"action":"managed_session"}  (voice-director.mjs hands it here);
 *   2. the tab door    GET /_host/voice/bridge, a WebSocket from the owner's own page;
 *   3. the provider door GET /door/voice-brain, the provider's Speech Engine socket (its JWT and the bridge secret).
 * Absent unless VOICE_MANAGED is exactly "1": with it off, nothing here is reached at all. The tab and provider doors
 * are never intercepted, so they answer exactly what any unknown path answers, and the owner action `managed_session`
 * is never dispatched, so it answers exactly what an unknown action answers (400 VOICE_ACTION_INVALID).
 * The provider can reach nothing but door 3, and door 3 accepts nothing but a transcript (journaled look-only) and
 * returns nothing but speakable text that passed the clause rules. No setting's value is ever written to a reply.
 */

import { VOICE_SESSION_LIMITS, validDurationSeconds } from './voice-session-policy.mjs'
import { CONVERSATION_ID_RE, SPEECH_ENGINE_AUTH_HEADER, SPEECH_ENGINE_TIMEOUT_SECONDS, verifySpeechEngineJwt } from './voice-provider-speech-engine.mjs'
import { FAST_VOICE_EFFORTS, FAST_VOICE_MODEL_RE, FAST_VOICE_PROVIDERS, fastVoiceStatus } from './voice-fast.mjs'
import { providerSideNotAsked, readProviderSide } from './voice-provider-side.mjs' // The provider's own account and conversation records

export const VOICE_BRIDGE_PROTOCOL = 'aukora.voice-bridge.v1'
export const VOICE_BRIDGE_ROUTES = Object.freeze({ tab: '/_host/voice/bridge', provider: '/door/voice-brain' })
/** The second header the provider sends (configured on the provider as a secret-valued request header). */
export const VOICE_BRIDGE_SECRET_HEADER = 'x-aukora-voice-bridge'
/** The names (never values) someone must set. VOICE_MANAGED lives in wrangler.toml [vars]; the rest are Worker secrets.
 * The managed voice uses ELEVENLABS_VOICE_API_KEY when it is set (the key of the account that owns the resource), and
 * otherwise ELEVENLABS_API_KEY; text-to-speech (eleven-speech.mjs) keeps reading ELEVENLABS_API_KEY only. */
export const VOICE_BRIDGE_SETTINGS = Object.freeze(['VOICE_MANAGED', 'ELEVENLABS_VOICE_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_X61_VOICE_RESOURCE_ID', 'ELEVENLABS_BRIDGE_SECRET'])
/** The closed list of recorded stages, per door (voice-bridge.md, "When the voice does not start"). No provider text,
 * header value or id is ever recorded: only the door, one of these and the time. */
export const VOICE_FAILURE_STAGES = Object.freeze({
  owner: Object.freeze(['duration-read', 'mint-401', 'mint-403', 'mint-404', 'mint-429', 'mint-5xx', 'mint-other', 'mint-timeout', 'mint-shape', 'bind']),
  // No `jwt-missing`: a request with no JWT needs nothing from the caller, so it is never recorded (any scanner sends one).
  // `frame-refused` (2026-11-18): the object closed the provider's socket over one of its frames: one parse could not
  // read (voice-provider-speech-engine.mjs parse gave null), or one refused as it arrived (over the socket's frame cap,
  // or too much already queued). Never the frame itself.
  provider: Object.freeze(['jwt-bad', 'secret-missing', 'secret-bad', 'init-unbound', 'init-timeout', 'frame-refused']),
})
/** The saved-duration read gets this much of the owner door's 12 s; the mint keeps the rest. */
/** Why a call ended and how a turn ended, in the status read (voice-bridge-do.mjs HISTORY_KEY says what each means). */
export const VOICE_CALL_ENDS = Object.freeze(['deadline', 'provider-closed', 'owner-stop', 'unclaimed', 'journal-unavailable', 'error'])
/** How a turn ended, and the closed reason (null: none). A turn
 * kept from before (done, late-answer, timeout) reads as answered, answered, failed. */
export const VOICE_TURN_OUTCOMES = Object.freeze(['answered', 'cancelled', 'failed', 'handed', 'refused'])
const OUTCOMES_BEFORE = Object.freeze({ done: 'answered', 'late-answer': 'answered', timeout: 'failed' })
export const VOICE_TURN_REASONS = Object.freeze(['barge_in', 'stop_words', 'turn_bound', 'first_event_bound', 'provider_status', 'request_shape', 'unreplayable',
  'journal', 'budget', 'tool_limit', 'tab_lost', 'model_refusal'])
/** A turn's millisecond marks from the transcript's arrival, its counts, and its tool calls (names only). */
export const VOICE_TURN_MARKS = Object.freeze(['journalMs', 'endMs'])
// `grown` is 1 when the turn's words were only the new part of an entry that grew (an older entry: 0).
export const VOICE_TURN_NUMBERS = Object.freeze(['calls', 'merged', 'cues', 'grown', 'resumed'])
export const VOICE_TOOL_NAMES = Object.freeze(['look', 'voice_scratch', 'think_deeper', 'hand_to_session', 'other'])
export const VOICE_TOOL_RESULTS = Object.freeze(['ok', 'timeout', 'refused', 'cancelled'])
export const VOICE_TOOL_ROUNDS_KEPT = 8
/** The bridge's counts the status shows (closed names, whole numbers). */
export const VOICE_STATUS_COUNTS = Object.freeze(['backchannelsKept', 'wordsMerged', 'stops', 'presenceCues', 'handoffsKept', 'handoffEchoes', 'fastFallbacks',
  'toolTimeouts', 'awareFrames', 'awareStoredLoads', 'blocksTrimmed',
  // Events that held nothing new from him, turns on only the new words of a grown entry, events whose
  // history ended with her entry.
  'nothingNew', 'grownTurns', 'agentTailEvents', 'resumes', 'resumesByHistory', 'resumeLimit',
  // Her voice memory (records written, her home's acks and refusals, heads adopted from her home).
  'memoryRecords', 'memoryAcks', 'memoryNacks', 'memoryAdoptedFromHome', 'memoryOtherOwner',
  // 2026-11-18 (every call ended by the provider about 2 s after it connected, and the status could not say whether the
  // provider ever reached the brain door): provider sockets the object accepted, valid inits, frames of a type the
  // adapter does not know (ignored), frames that closed the socket; tab sockets accepted, hellos that claimed a place,
  // hellos refused; bound starts nobody claimed before their window passed. Since this object last started.
  'brainSockets', 'brainInits', 'brainFramesOther', 'brainFramesRefused', 'tabSockets', 'tabHellos', 'tabHellosRefused', 'startsUnclaimed'])
/** Her voice memory in the status (the voice memory design "Status"), as an empty edge reads (the status shows null when the bridge was not read). */
export const VOICE_MEMORY_EMPTY = Object.freeze({ seq: 0, digest12: '000000000000', synced: 0, unsynced: 0, gapFrom: null, adoptedFromHome: false, fork: false })
/** The memory object, closed: whole numbers, 12 lower-case hex, a seq or null, two booleans; anything else is null. */
export function readMemoryStatus(value) {
  if (!isObject(value) || wholeCount(value.seq) === null || typeof value.digest12 !== 'string' || !/^[0-9a-f]{12}$/.test(value.digest12)
    || wholeCount(value.synced) === null || wholeCount(value.unsynced) === null || !(value.gapFrom === null || wholeCount(value.gapFrom) !== null)
    || typeof value.adoptedFromHome !== 'boolean' || typeof value.fork !== 'boolean') return null
  return { seq: value.seq, digest12: value.digest12, synced: value.synced, unsynced: value.unsynced, gapFrom: value.gapFrom, adoptedFromHome: value.adoptedFromHome, fork: value.fork }
}
/** the voice fix/E7: the stream block types whose start keys are named, at most this many names each, each this shape. */
export const VOICE_STREAM_BLOCKS = Object.freeze(['text', 'thinking', 'tool_use'])
export const VOICE_STREAM_KEYS_MAX = 12
export const VOICE_STREAM_KEY_RE = /^[a-z_]{1,24}$/
/** the voice tools part 2 (2026-11-16): the closed kind of the provider SDK's last error in a call, as the page's `bye` names it
 * (managed-voice/policy.mjs SDK_ERROR_KINDS; never the SDK's words). A call row carries `sdk` only when the page sent one. */
export const VOICE_SDK_KINDS = Object.freeze(['socket', 'server', 'audio', 'permission', 'other'])
/** Which of the edge's cues a turn said (2026-11-16): none, the early acknowledgement, or the timeout-protection cue
 * (the last one said; the timeout cue may follow the early one). */
export const VOICE_TURN_CUES = Object.freeze(['none', 'early', 'timeout'])
/** A turn's timings in the status read (2026-11-16), whole milliseconds from the transcript's arrival at the bridge, each
 * measured on the bridge object's own clock (never a difference between two machines' clocks), each null when not
 * observed: the journal row confirmed, the `turn` frame handed to the tab, her first text from the tab, her first speech
 * chunk sent to the provider. */
export const VOICE_TURN_TIMINGS = Object.freeze(['journaledMs', 'handedMs', 'firstTextMs', 'firstSpeechMs', 'modelFirstMs'])
/** Which path answered a turn: the bridge's fast voice, the governed hand-off to her tab, or the
 * fast voice falling back to the governed hand-off (no first text in time, or the fast call failed). `modelFirstMs` (a
 * timing above) is the fast model's first text, null on the governed path. */
export const VOICE_TURN_PATHS = Object.freeze(['fast', 'governed', 'fast_fell_back'])
/** Who chose a fast Claude turn's level: the edge's default, his own words, or her think_deeper. */
export const VOICE_EFFORT_BY = Object.freeze(['default', 'owner', 'self'])
/** How many of each the status read shows. 12 calls (was 4 until 2026-11-18: four rows are too few to read a run of
 * calls that each end within seconds). */
export const VOICE_STATUS_CALLS = 12
export const VOICE_STATUS_TURNS = 24
export const DURATION_READ_DEADLINE_MS = 3000
/** A refused request at the provider door is recorded at most once per stage per this long (per isolate), so a stranger
 * can never turn the door into a stream of writes. */
export const PROVIDER_NOTE_INTERVAL_MS = 60000
export const VOICE_BRIDGE_BINDING = 'VOICE_BRIDGE'
export const VOICE_BRIDGE_OBJECT_NAME = 'x61-voice-bridge-v1'
/** The owner door's operational refusals (a closed list). Owner, origin and malformed-request refusals are the route's
 * own (OWNER_ACCESS_REQUIRED, SAME_ORIGIN_BROWSER_REQUIRED, VOICE_ACTION_INVALID) and are not part of it. */
export const MANAGED_SESSION_REFUSALS = Object.freeze({
  VOICE_NOT_CONFIGURED: 503, VOICE_QUOTA: 429, VOICE_PROVIDER_UNAVAILABLE: 503, VOICE_BUSY: 409,
})
export const PROVIDER_DEADLINE_MS = 12000
export const TOKEN_LENGTH = Object.freeze({ min: 40, max: 16384 })
export const BRIDGE_SECRET_MIN_CHARS = 32
const PROVIDER_ORIGIN = 'https://api.elevenlabs.io'
export const PROVIDER_JSON_MAX_BYTES = 65536
const RESOURCE_RE = /^(?:agent|seng)_[A-Za-z0-9]{1,64}$/
const HEX_64 = /^[0-9a-f]{64}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const refusal = code => json({ ok: false, code }, MANAGED_SESSION_REFUSALS[code])

/** The switch: exactly the string "1" turns the managed voice on; anything else (unset included) is off. */
export const voiceManagedOn = env => env?.VOICE_MANAGED === '1'

const settingText = (env, name) => (typeof env?.[name] === 'string' ? env[name].trim() : '')

/** The NAME of the key the managed voice uses (both provider calls and the provider's JWT check), or null. */
export function managedVoiceKeyName(env) {
  if (settingText(env, 'ELEVENLABS_VOICE_API_KEY')) return 'ELEVENLABS_VOICE_API_KEY'
  return settingText(env, 'ELEVENLABS_API_KEY') ? 'ELEVENLABS_API_KEY' : null
}

/** The three settings by NAME: what is present, never a value. */
export function managedVoiceSettings(env) {
  const text = name => settingText(env, name)
  const keyName = managedVoiceKeyName(env)
  const apiKey = keyName ? text(keyName) : '', resourceId = text('ELEVENLABS_X61_VOICE_RESOURCE_ID'), bridgeSecret = text('ELEVENLABS_BRIDGE_SECRET')
  const missing = [
    ...(apiKey ? [] : ['ELEVENLABS_API_KEY']),
    ...(RESOURCE_RE.test(resourceId) ? [] : ['ELEVENLABS_X61_VOICE_RESOURCE_ID']),
    ...(bridgeSecret.length >= BRIDGE_SECRET_MIN_CHARS ? [] : ['ELEVENLABS_BRIDGE_SECRET']),
    ...(env?.[VOICE_BRIDGE_BINDING] ? [] : [VOICE_BRIDGE_BINDING]),
  ]
  return missing.length ? { ok: false, missing } : { ok: true, apiKey, resourceId, bridgeSecret }
}

/** The owner as speech_pass judges him, AND a current passkey session (an ambient owner pass alone is not enough). */
export function managedVoiceOwner(access, env, at) {
  return access?.type === 'owner' && typeof access.email === 'string' && access.email.length <= 254
    && /^[^\s@]+@[^\s@]+$/.test(access.email) && typeof env?.OWNER_EMAIL === 'string'
    && access.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
    && Number.isFinite(access.expires) && Number.isFinite(at) && access.expires > at / 1000
    && typeof access.session === 'string' && access.session.length > 0
}

/** Constant-time comparison of the bridge secret header against the edge's setting (both hashed to equal length). */
export async function bridgeSecretMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false
  const [a, b] = await Promise.all([presented, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))))
  const left = new Uint8Array(a), right = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

const bridgeStub = env => env[VOICE_BRIDGE_BINDING].get(env[VOICE_BRIDGE_BINDING].idFromName(VOICE_BRIDGE_OBJECT_NAME))

async function admit(env, body) {
  const response = await bridgeStub(env).fetch(new Request('https://x61.internal/voice-bridge/admit', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1' }, body: JSON.stringify(body),
  }))
  const answer = await response.json().catch(() => null)
  return isObject(answer) ? answer : { ok: false, code: 'VOICE_PROVIDER_UNAVAILABLE' }
}

/** Record one closed stage in the bridge object (best effort: a failed record never changes an answer). */
async function noteFailure(env, door, stage, at) {
  await admit(env, { action: 'failure', door, stage, at }).catch(() => null)
}

/** Per isolate (module scope, never keyed by the env object, which the runtime may hand out fresh per request): when
 * each provider-door stage was last recorded (the throttle above). */
const providerNotes = new Map()
/** Forget the throttle, as a fresh isolate would (the tests' fixtures each stand for one isolate). */
export function forgetProviderNotes() {
  providerNotes.clear()
}
async function noteProviderRefusal(env, stage, at) {
  const last = providerNotes.get(stage)
  if (last !== undefined && at - last < PROVIDER_NOTE_INTERVAL_MS && at >= last) return
  providerNotes.set(stage, at)
  await noteFailure(env, 'provider', stage, at)
}

/** A provider call that failed, with the closed stage that says why (never the provider's text). `answered` is true
 * only when the provider answered with a definite non-2xx status or a redirect: no token came back, so no conversation
 * can exist for it (the owner door then gives the seconds back). */
class ProviderFailure extends Error {
  constructor(stage, answered = false) {
    super('VOICE_PROVIDER_UNAVAILABLE')
    this.stage = stage
    this.answered = answered
  }
}
const statusStage = status => ([401, 403, 404, 429].includes(status) ? `mint-${String(status)}` : status >= 500 && status <= 599 ? 'mint-5xx' : 'mint-other')

/** A response body read piece by piece and cancelled the moment it passes `max` bytes (never read whole first). */
export async function readBounded(response, max) {
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
      throw new Error('VOICE_PROVIDER_UNAVAILABLE')
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const part of parts) { bytes.set(part, at); at += part.byteLength }
  return bytes
}

/** One bounded JSON read from the provider: manual redirects, the given deadline, a size cap while reading, no text
 * kept. A failure throws a ProviderFailure whose stage is the mint's (the caller of the duration read ignores it):
 * the HTTP status class, `mint-timeout` when the deadline ended it, `mint-shape` for a 2xx that is not bounded JSON. */
async function providerJson(networkFetch, path, apiKey, signal) {
  let response
  try {
    response = await networkFetch(PROVIDER_ORIGIN + path, { method: 'GET', headers: { 'xi-api-key': apiKey }, redirect: 'manual', signal })
  } catch {
    throw new ProviderFailure(signal.aborted ? 'mint-timeout' : 'mint-other')
  }
  const length = response.headers.get('content-length')
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {})
    throw new ProviderFailure(response.redirected ? 'mint-other' : statusStage(response.status), true)
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || length !== null && (!/^\d+$/.test(length) || Number(length) > PROVIDER_JSON_MAX_BYTES)) {
    await response.body?.cancel().catch(() => {})
    throw new ProviderFailure('mint-shape')
  }
  let bytes
  try {
    bytes = await readBounded(response, PROVIDER_JSON_MAX_BYTES)
  } catch {
    throw new ProviderFailure(signal.aborted ? 'mint-timeout' : 'mint-shape')
  }
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    throw new ProviderFailure('mint-shape')
  }
}

/**
 * THE PROVIDER'S SAVED VOICE SETTINGS, from the same best-effort read of the saved resource as the
 * duration (no new request, no new secret). Each is the saved value when the read carries it in its documented place
 * (scout-1113 VOICE-PROVIDER.md: an agent under `conversation_config.{tts,asr,turn}` and the per-event wait at
 * `conversation_config.agent.prompt.cascade_timeout_seconds`; a speech engine under `tts`, `asr`, `turn` and
 * `cascade_timeout_seconds`, the create body's places, read back by id: UNVERIFIED, as the duration is) AND within its
 * closed shape: a model id, a voice id, a boolean, a finite number, a short lower-case word; else "not read". Never any
 * other field of the resource. `waitMatches`: whether the saved per-event wait equals SPEECH_ENGINE_TIMEOUT_SECONDS.
 *
 * 2026-11-18 (every call ended by the provider about 2 s after it connected): MORE CLOSED FACTS from the same read, in the
 * places of the provider's documented GET /v1/speech-engine/{id} answer. Where its brain socket points (`brainUrl`: ours,
 * other or missing; the address itself is never kept), what KIND of value is saved under the bridge secret header
 * (`brainHeader`: text, secret, variable or missing; the value is never read into anything kept), the first-message
 * override, whether the provider's own auth is on, the call limits, the saved call length, the turn waits, and when and
 * from where the resource was last changed. An agent resource has none of these places except `metadata`: the rest read
 * "not read" for it. Each closer below must accept its own output unchanged (the object and the Worker's status close
 * the stored object again), so `brainUrl` and `brainHeader` are computed in providerSettings and only checked here.
 */
export const VOICE_PROVIDER_SETTINGS = Object.freeze(['speakingModel', 'voice', 'expressiveMode', 'stability', 'speed', 'listeningModel', 'listeningQuality',
  'turnEagerness', 'silenceEndCallSeconds', 'eventWaitSeconds',
  'brainUrl', 'brainHeader', 'overrideFirstMessage', 'authEnabled', 'dailyLimit', 'concurrencyLimit', 'maxDurationSeconds', 'turnTimeoutSeconds',
  'initialWaitSeconds', 'updatedAtSeconds', 'updatedFrom'])
const NOT_READ = 'not read'
export const BRAIN_URL_KINDS = Object.freeze(['ours', 'other', 'missing'])
export const BRAIN_HEADER_KINDS = Object.freeze(['text', 'secret', 'variable', 'missing'])
/** The provider's documented `metadata.last_updated_from` words. */
export const PROVIDER_UPDATED_FROM = Object.freeze(['cli', 'ui', 'api', 'template', 'architect', 'mcp', 'unknown'])
/** 2100-01-01 in unix seconds: a later "last updated" is not a time this edge believes. */
const UPDATED_AT_MAX_SECONDS = 4102444800
const MODEL_ID_RE = /^[a-z0-9_.-]{1,60}$/
const VOICE_ID_RE = /^[A-Za-z0-9]{1,40}$/
const WORD_RE = /^[a-z_]{1,24}$/
const closedModel = value => (typeof value === 'string' && MODEL_ID_RE.test(value) ? value : NOT_READ)
const closedVoice = value => (typeof value === 'string' && VOICE_ID_RE.test(value) ? value : NOT_READ)
const closedBoolean = value => (typeof value === 'boolean' ? value : NOT_READ)
const closedNumber = value => (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000 ? value : NOT_READ)
const closedWord = value => (typeof value === 'string' && WORD_RE.test(value) ? value : NOT_READ)
const closedIn = list => value => (list.includes(value) ? value : NOT_READ)
/** A whole count the provider saves (a limit, a length): -1 is the provider's "none". */
const closedWhole = value => (Number.isSafeInteger(value) && value >= -1 && value <= 1_000_000_000 ? value : NOT_READ)
const closedUnixSeconds = value => (Number.isSafeInteger(value) && value >= 1 && value <= UPDATED_AT_MAX_SECONDS ? value : NOT_READ)
const CLOSED_SETTINGS = Object.freeze({ speakingModel: closedModel, voice: closedVoice, expressiveMode: closedBoolean, stability: closedNumber, speed: closedNumber,
  listeningModel: closedModel, listeningQuality: closedWord, turnEagerness: closedWord, silenceEndCallSeconds: closedNumber, eventWaitSeconds: closedNumber,
  brainUrl: closedIn(BRAIN_URL_KINDS), brainHeader: closedIn(BRAIN_HEADER_KINDS), overrideFirstMessage: closedBoolean, authEnabled: closedBoolean,
  dailyLimit: closedWhole, concurrencyLimit: closedWhole, maxDurationSeconds: closedWhole, turnTimeoutSeconds: closedNumber, initialWaitSeconds: closedNumber,
  updatedAtSeconds: closedUnixSeconds, updatedFrom: closedIn(PROVIDER_UPDATED_FROM) })

/** Where the saved brain socket points, as one word: 'ours' only for exactly wss://<the edge's own host><the provider
 * door> with no query and no fragment; 'missing' for no address; 'other' for anything else, one that does not parse
 * included. Not read without the speech_engine object or without the edge's own host. The address is never returned. */
function brainUrlKind(engine, host) {
  if (!isObject(engine) || typeof host !== 'string' || !host) return NOT_READ
  const address = engine.ws_url
  if (typeof address !== 'string' || !address) return 'missing'
  let parsed
  try { parsed = new URL(address) } catch { return 'other' }
  return parsed.protocol === 'wss:' && parsed.host === host && parsed.pathname === VOICE_BRIDGE_ROUTES.provider && !parsed.search && !parsed.hash ? 'ours' : 'other'
}
/** The KIND of value saved under the bridge secret header (its name matched without case): a plain text value, a
 * reference to a provider-held secret, a reference to a variable, or no such header. A value of any other shape, or the
 * header saved twice under two spellings (which one is sent cannot be told), is not read. The value is never returned. */
function brainHeaderKind(engine) {
  if (!isObject(engine)) return NOT_READ
  const headers = engine.request_headers
  if (headers === undefined || headers === null) return 'missing'
  if (!isObject(headers)) return NOT_READ
  const names = Object.keys(headers).filter(name => name.toLowerCase() === VOICE_BRIDGE_SECRET_HEADER)
  if (names.length === 0) return 'missing'
  if (names.length > 1) return NOT_READ
  const value = headers[names[0]]
  if (typeof value === 'string') return 'text'
  if (isObject(value) && typeof value.secret_id === 'string') return 'secret'
  if (isObject(value) && typeof value.variable_name === 'string') return 'variable'
  return NOT_READ
}

/** `host`: the edge's own host (the owner door's url.host), for `brainUrl`. */
export function providerSettings(resourceId, saved, host) {
  const agent = typeof resourceId === 'string' && resourceId.startsWith('agent_')
  const base = agent ? saved?.conversation_config : saved
  const part = name => (isObject(base?.[name]) ? base[name] : {})
  // The speech engine's own places; an agent has none of them (its shape differs), so each reads "not read" for it.
  const engine = agent || !isObject(saved) ? {} : saved
  const of = name => (isObject(engine[name]) ? engine[name] : {})
  const metadata = isObject(saved?.metadata) ? saved.metadata : {}
  const raw = { speakingModel: part('tts').model_id, voice: part('tts').voice_id, expressiveMode: part('tts').expressive_mode, stability: part('tts').stability,
    speed: part('tts').speed, listeningModel: part('asr').provider, listeningQuality: part('asr').quality, turnEagerness: part('turn').turn_eagerness,
    silenceEndCallSeconds: part('turn').silence_end_call_timeout, eventWaitSeconds: agent ? base?.agent?.prompt?.cascade_timeout_seconds : base?.cascade_timeout_seconds,
    brainUrl: brainUrlKind(engine.speech_engine, host), brainHeader: brainHeaderKind(engine.speech_engine),
    overrideFirstMessage: of('overrides').first_message, authEnabled: of('auth').enable_auth,
    dailyLimit: of('call_limits').daily_limit, concurrencyLimit: of('call_limits').agent_concurrency_limit,
    maxDurationSeconds: of('conversation').max_duration_seconds, turnTimeoutSeconds: of('turn').turn_timeout, initialWaitSeconds: of('turn').initial_wait_time,
    updatedAtSeconds: metadata.updated_at_unix_secs, updatedFrom: metadata.last_updated_from }
  return readProviderSettings(raw)
}
/** The settings object, each value closed again (the object and the Worker both read it through here). */
export function readProviderSettings(value) {
  const out = Object.fromEntries(VOICE_PROVIDER_SETTINGS.map(name => [name, CLOSED_SETTINGS[name](isObject(value) ? value[name] : undefined)]))
  out.waitMatches = out.eventWaitSeconds === NOT_READ ? NOT_READ : out.eventWaitSeconds === SPEECH_ENGINE_TIMEOUT_SECONDS
  return out
}

/** The provider's saved conversation length for the one resource, in seconds (agent: SOURCE website code; speech
 * engine: the create body's `conversation.max_duration_seconds`, read back by id, UNVERIFIED). */
function savedDuration(resourceId, saved) {
  const seconds = resourceId.startsWith('agent_') ? saved?.conversation_config?.conversation?.max_duration_seconds : saved?.conversation?.max_duration_seconds
  return validDurationSeconds(seconds)
}

/**
 * Door 1, reached only with the switch on: voice-director.mjs dispatches `managed_session` here only when
 * voiceManagedOn(env), and that one line is the switch for this door (with it off the action is unknown). The body is exactly
 * {"action":"managed_session"}. Owner (with a passkey session), origin and same-origin as speech_pass; then the
 * settings; then ADMISSION, atomically in the bridge object: it reserves min(1,200 s, what is left of the day, what is
 * left of the month), and refuses VOICE_QUOTA under 60 s; then, under one 12 s deadline, the saved duration (BEST
 * EFFORT, at most 3 s of it: any failure means the reserved seconds are used) and the mint for the ONE resource the
 * edge holds, with the managed voice's key (ELEVENLABS_VOICE_API_KEY, else ELEVENLABS_API_KEY). The answer is
 * { token, maxDurationSeconds } and nothing else: the reserved seconds, or the provider's shorter saved duration. That
 * number is what the bridge enforces by ending the conversation itself. Every refusal after admission records one
 * closed stage in the bridge object (VOICE_FAILURE_STAGES.owner); a failed duration read is recorded too.
 * @param {object} options request, url, env, seedId, access, networkFetch, now, input (the parsed body).
 * @returns {Promise<Response>} The two fields, or a refusal from the closed list.
 */
export async function handleManagedSession({ request, url, env, seedId, access, networkFetch, now = Date.now, input }) {
  if (!isObject(input) || Object.keys(input).length !== 1 || input.action !== 'managed_session') return json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400)
  const at = now()
  if (!managedVoiceOwner(access, env, at)) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
  const settings = managedVoiceSettings(env)
  if (!settings.ok || !HEX_64.test(seedId ?? '') || typeof networkFetch !== 'function') return refusal('VOICE_NOT_CONFIGURED')

  let reserved
  try {
    reserved = await admit(env, { action: 'reserve', seconds: VOICE_SESSION_LIMITS.seconds, at })
  } catch {
    // The reservation call itself failed: no slot id came back, so there is nothing of ours to give back.
    return refusal('VOICE_PROVIDER_UNAVAILABLE')
  }
  if (reserved.ok !== true || typeof reserved.slot !== 'string' || validDurationSeconds(reserved.seconds) === null) {
    return refusal(['VOICE_QUOTA', 'VOICE_BUSY'].includes(reserved.code) ? reserved.code : 'VOICE_PROVIDER_UNAVAILABLE')
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(PROVIDER_DEADLINE_MS)])
  // The stages to record, written to the bridge object only after the provider calls (never inside their deadline).
  const stages = []
  const refuse = async stage => {
    stages.push(stage)
    for (const item of stages) await noteFailure(env, 'owner', item, now())
    return refusal('VOICE_PROVIDER_UNAVAILABLE')
  }

  // 1. The saved duration, best effort: a failure of any kind (status, type, size, its 3 s, a shape without the
  //    field, a number out of range) means the reserved seconds. It never refuses the session.
  let saved = null
  // The provider's saved voice settings from this SAME read (closed values only), for the status.
  let seen = null
  try {
    const kind = settings.resourceId.startsWith('agent_') ? '/v1/convai/agents/' : '/v1/speech-engine/'
    const readSignal = AbortSignal.any([signal, AbortSignal.timeout(DURATION_READ_DEADLINE_MS)])
    const resource = await providerJson(networkFetch, kind + settings.resourceId, settings.apiKey, readSignal)
    seen = providerSettings(settings.resourceId, resource, url.host)
    saved = savedDuration(settings.resourceId, resource)
  } catch {
    saved = null
  }
  if (saved === null) stages.push('duration-read')
  let seconds = reserved.seconds
  if (saved !== null && saved < reserved.seconds) {
    let trimmed = null
    try {
      trimmed = await admit(env, { action: 'trim', slot: reserved.slot, seconds: saved })
    } catch {
      trimmed = null
    }
    if (trimmed?.ok !== true) {
      // Before any mint call nothing can have started: the slot AND its seconds are given back.
      await admit(env, { action: 'refund', slot: reserved.slot }).catch(() => null)
      return await refuse('bind')
    }
    seconds = saved
  }

  // 2. The mint. A mint the provider answered with a status or a redirect started nothing: the slot AND its seconds
  //    are given back (a wrong key must never spend the owner's day and month, review MUST). A timeout, a network
  //    failure or a 2xx without a usable token and id keeps the seconds reserved (a conversation may exist); the live
  //    slot is let go.
  let token, conv
  try {
    const minted = await providerJson(networkFetch, '/v1/convai/conversation/token?agent_id=' + encodeURIComponent(settings.resourceId), settings.apiKey, signal)
    token = minted?.token
    conv = typeof minted?.conversation_id === 'string' ? minted.conversation_id : minted?.conversationId
    // A token without a conversation id cannot be bound: that is the provider's answer shape, not a usable session.
    if (typeof token !== 'string' || token.length < TOKEN_LENGTH.min || token.length > TOKEN_LENGTH.max || token.includes(settings.apiKey)
      || typeof conv !== 'string' || !CONVERSATION_ID_RE.test(conv)) throw new ProviderFailure('mint-shape')
  } catch (error) {
    const answered = error instanceof ProviderFailure && error.answered === true
    await admit(env, { action: answered ? 'refund' : 'release', slot: reserved.slot }).catch(() => null)
    return await refuse(error instanceof ProviderFailure ? error.stage : 'mint-other')
  }

  // 3. The binding of the slot to this conversation.
  let bound = null
  try {
    bound = await admit(env, { action: 'bind', slot: reserved.slot, conv, owner: access.email.toLowerCase(), seedId, at: now() })
  } catch {
    bound = null
  }
  if (bound?.ok !== true) {
    // The provider was called: the live slot is let go, the seconds stay reserved (no refund in this version).
    await admit(env, { action: 'release', slot: reserved.slot }).catch(() => null)
    return await refuse('bind')
  }
  for (const item of stages) await noteFailure(env, 'owner', item, now())
  // What the read carried, kept in the bridge object for the status (best effort; never changes the answer).
  if (seen) await admit(env, { action: 'provider', provider: seen, at: now() }).catch(() => null)
  return json({ token, maxDurationSeconds: seconds })
}

const nameState = (env, name) => (settingText(env, name) ? 'set' : 'missing')

/**
 * The owner's read of the managed voice, on the same route: POST /_host/voice {"action":"managed_status"}. Same owner
 * (with a passkey session) and same-origin checks as door 1; it answers with the switch on or off, since it is a read
 * about configuration. NAMES and closed values only, never a setting's value, an id or provider text. With the switch
 * off the bridge object is not reached (it stays unbuilt, as the switch promises): `live` is 0 and `failures` is [].
 * @param {object} options request, url, env, access, now, input (the parsed body).
 * The last 12 calls (seconds granted, how each ended, how long it lasted), the last 24 turns (outcome, seconds to her
 * first words, longest quiet) and the seconds left today and this month ride beside them (2026-11-14).
 * `fast` is her fast voice's line (voice-fast.mjs fastVoiceStatus): on or off, the provider NAME, the model
 * id and why it is off (for example provider-not-configured: its key binding is not set). Never a value.
 * @returns {Promise<Response>} { switch, names, keyInUse, resourceKind, live, failures, calls, turns, secondsLeft, fast }.
 */
export async function handleManagedStatus({ request, url, env, access, networkFetch, now = Date.now, input }) {
  if (!isObject(input) || Object.keys(input).length !== 1 || input.action !== 'managed_status') return json({ ok: false, code: 'VOICE_ACTION_INVALID' }, 400)
  const at = now()
  if (!managedVoiceOwner(access, env, at)) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
  const on = voiceManagedOn(env)
  const resourceId = settingText(env, 'ELEVENLABS_X61_VOICE_RESOURCE_ID')
  const resourceKind = !RESOURCE_RE.test(resourceId) ? null : resourceId.startsWith('seng_') ? 'speech-engine' : 'agent'
  let live = 0, failures = [], calls = [], turns = [], secondsLeft = null, counts = readCounts(null), streamKeys = {}, memory = null
  // Memory is null (not read) unless the bridge was read: never an empty memory guessed.
  let provider = { readAtMs: null, ...readProviderSettings(null) }
  if (on && env?.[VOICE_BRIDGE_BINDING]) {
    const status = await admit(env, { action: 'status', at }).catch(() => null)
    if (status?.ok === true) {
      live = Number.isSafeInteger(status.live) && status.live >= 0 ? status.live : 0
      failures = Array.isArray(status.failures) ? status.failures.filter(item => isObject(item)
        && Object.hasOwn(VOICE_FAILURE_STAGES, item.door) && VOICE_FAILURE_STAGES[item.door].includes(item.stage) && Number.isSafeInteger(item.atMs))
        .map(item => ({ door: item.door, stage: item.stage, atMs: item.atMs })) : []
      calls = readCalls(status.calls)
      turns = readTurns(status.turns)
      secondsLeft = isObject(status.secondsLeft) && wholeCount(status.secondsLeft.today) !== null && wholeCount(status.secondsLeft.month) !== null
        ? { today: status.secondsLeft.today, month: status.secondsLeft.month } : null
      counts = readCounts(status.counts)
      streamKeys = readStreamKeys(status.streamKeys)
      memory = readMemoryStatus(status.memory)
      if (isObject(status.provider) && Number.isSafeInteger(status.provider.readAtMs)) provider = { readAtMs: status.provider.readAtMs, ...readProviderSettings(status.provider.settings) }
    } else {
      live = null
      failures = null
      calls = null
      turns = null
      memory = null
    }
  }
  // What the PROVIDER says about its own side, read now with the managed voice's key: the
  // account (credits, limit, state) and the newest conversations with how each ended in the provider's own words. Best
  // effort under one 5 s deadline; closed values and cut, plain text only (voice-provider-side.mjs); never stored.
  const sideSettings = managedVoiceSettings(env)
  const providerSide = on && sideSettings.apiKey && RESOURCE_RE.test(sideSettings.resourceId)
    ? await readProviderSide({ networkFetch, apiKey: sideSettings.apiKey, resourceId: sideSettings.resourceId, now })
    : providerSideNotAsked(at)
  return json({
    switch: on ? 'on' : 'off',
    names: Object.fromEntries(['VOICE_MANAGED', 'ELEVENLABS_VOICE_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_X61_VOICE_RESOURCE_ID', 'ELEVENLABS_BRIDGE_SECRET']
      .map(name => [name, nameState(env, name)])),
    keyInUse: managedVoiceKeyName(env),
    resourceKind,
    live,
    failures,
    calls,
    turns,
    secondsLeft,
    // the voice fix/E7: the bridge's counts and the key names of the last call's stream block starts.
    counts,
    streamKeys,
    // Her voice memory (numbers, 12 hex and booleans; never a word).
    memory,
    // The provider's saved voice settings as the last session's read carried them (closed values, else
    // "not read"), and whether its per-event wait equals the edge's.
    provider,
    // The provider's own records (see above). Its reason texts are the provider's words: data, not instructions.
    providerSide,
    fast: fastVoiceStatus(env),
  })
}

const wholeCount = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)
/** The last calls, newest first: closed values and numbers only (no id, no text). */
const readCalls = value => (Array.isArray(value) ? value.filter(item => isObject(item) && VOICE_CALL_ENDS.includes(item.ended)
  && wholeCount(item.grantedSeconds) !== null && wholeCount(item.lastedSeconds) !== null && Number.isSafeInteger(item.atMs))
  .slice(0, VOICE_STATUS_CALLS).map(item => ({ grantedSeconds: item.grantedSeconds, ended: item.ended, lastedSeconds: item.lastedSeconds, atMs: item.atMs,
    ...(VOICE_SDK_KINDS.includes(item.sdk) ? { sdk: item.sdk } : {}) })) : [])
/** The last turns, newest first: the outcome, seconds to her first words (null: none), the longest quiet, the five
 * timings (VOICE_TURN_TIMINGS), the cue said and the path (VOICE_TURN_PATHS). A timing that is not a whole count, and a cue outside the closed list
 * (an entry kept from before 2026-11-16 has neither), reads as null. */
const outcomeOf = value => (VOICE_TURN_OUTCOMES.includes(value) ? value : OUTCOMES_BEFORE[value])
/** Up to 8 tool calls, each its tool name (closed list), two marks and how it ended; nothing else. */
const readToolRounds = value => (Array.isArray(value) ? value.filter(item => isObject(item) && VOICE_TOOL_NAMES.includes(item.tool)).slice(0, VOICE_TOOL_ROUNDS_KEPT)
  .map(item => ({ tool: item.tool, sentMs: wholeCount(item.sentMs), backMs: wholeCount(item.backMs), result: VOICE_TOOL_RESULTS.includes(item.result) ? item.result : null })) : [])
/** The counts, by their closed names, whole numbers only. */
export const readCounts = value => Object.fromEntries(VOICE_STATUS_COUNTS.map(name => [name, wholeCount(isObject(value) ? value[name] : undefined) ?? 0]))
/** The key NAMES seen on the last call's stream block starts, per block type; names only, never a value. */
export const readStreamKeys = value => Object.fromEntries(VOICE_STREAM_BLOCKS.filter(type => isObject(value) && Array.isArray(value[type]))
  .map(type => [type, [...new Set(value[type].filter(name => typeof name === 'string' && VOICE_STREAM_KEY_RE.test(name)))].slice(0, VOICE_STREAM_KEYS_MAX)]))
const readTurns = value => (Array.isArray(value) ? value.filter(item => isObject(item) && outcomeOf(item.outcome) !== undefined
  && (item.firstWordsSeconds === null || wholeCount(item.firstWordsSeconds) !== null) && wholeCount(item.longestQuietSeconds) !== null && Number.isSafeInteger(item.atMs))
  .slice(0, VOICE_STATUS_TURNS).map(item => ({ outcome: outcomeOf(item.outcome), firstWordsSeconds: item.firstWordsSeconds, longestQuietSeconds: item.longestQuietSeconds,
    ...Object.fromEntries(VOICE_TURN_TIMINGS.map(name => [name, wholeCount(item[name])])),
    // Why it ended and how long each step took; closed codes and numbers only.
    reason: VOICE_TURN_REASONS.includes(item.reason) ? item.reason : null,
    ...Object.fromEntries(VOICE_TURN_MARKS.map(name => [name, wholeCount(item[name])])),
    ...Object.fromEntries(VOICE_TURN_NUMBERS.map(name => [name, wholeCount(item[name]) ?? 0])),
    toolRounds: readToolRounds(item.toolRounds),
    cue: VOICE_TURN_CUES.includes(item.cue) ? item.cue : null, path: VOICE_TURN_PATHS.includes(item.path) ? item.path : null,
    // A fast turn's provider NAME (from the closed table) and model id (an id, or null); none on a governed turn.
    ...(Object.hasOwn(item, 'provider') ? { provider: typeof item.provider === 'string' && Object.hasOwn(FAST_VOICE_PROVIDERS, item.provider) ? item.provider : null,
      model: typeof item.model === 'string' && FAST_VOICE_MODEL_RE.test(item.model) ? item.model : null } : {}),
    // The level a fast Claude turn ran at (FAST_VOICE_EFFORTS) and who chose it (VOICE_EFFORT_BY); a level
    // he asked for that the edge does not offer. Closed values only, else null.
    ...(Object.hasOwn(item, 'effort') ? { effort: FAST_VOICE_EFFORTS.includes(item.effort) ? item.effort : null,
      effortBy: VOICE_EFFORT_BY.includes(item.effortBy) ? item.effortBy : null } : {}),
    ...(Object.hasOwn(item, 'effortNotOffered') ? { effortNotOffered: FAST_VOICE_EFFORTS.includes(item.effortNotOffered) ? item.effortNotOffered : null } : {}),
    atMs: item.atMs })) : [])

const internalUpgrade = (path, extra = {}) => new Request('https://x61.internal' + path, {
  method: 'GET', headers: { upgrade: 'websocket', 'x-x6-internal-authorized': '1', ...extra },
})

/**
 * Door 2, judged in the Worker before the object: a WebSocket upgrade from the owner's own page (Origin equal to the
 * edge, as /_head/ws), the owner with a passkey session, no query. The object binds it at `hello`.
 * @returns {Promise<Response>} The object's 101, or a refusal.
 */
export async function voiceBridgeTabDoor(request, env, url, access, now = Date.now) {
  if (url.search || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
  if (request.method !== 'GET') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
  if (request.headers.get('origin') !== url.origin) return json({ ok: false, code: 'ORIGIN_REFUSED' }, 403)
  if (!managedVoiceOwner(access, env, now())) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ ok: false, code: 'WEBSOCKET_UPGRADE_REQUIRED' }, 426)
  if (!managedVoiceSettings(env).ok) return refusal('VOICE_NOT_CONFIGURED')
  return await bridgeStub(env).fetch(internalUpgrade('/voice-bridge/tab', { 'x-x6-voice-owner': access.email.toLowerCase() }))
}

/**
 * Door 3, judged in the Worker before the object, and cheap: a WebSocket upgrade with no query, the provider's JWT
 * (verifySpeechEngineJwt, keyed with the managed voice's key) AND the bridge secret header. Anything short of all of
 * that returns null: the caller then answers it as it answers any unknown path (no detail). A request with no JWT is
 * not recorded (it needs nothing from the caller). A bad JWT or a secret refusal is recorded as one closed stage, at
 * most once per stage per minute per isolate (a stranger cannot make it a stream; `jwt-bad` may be a stranger's).
 * @returns {Promise<Response|null>} The object's 101, or null.
 */
export async function voiceBridgeProviderDoor(request, env, url, now = Date.now) {
  if (request.method !== 'GET' || url.search || url.hash || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null
  const settings = managedVoiceSettings(env)
  if (!settings.ok) return null
  const jwtHeader = request.headers.get(SPEECH_ENGINE_AUTH_HEADER), secretHeader = request.headers.get(VOICE_BRIDGE_SECRET_HEADER)
  const [jwt, secret] = await Promise.all([
    verifySpeechEngineJwt(jwtHeader, settings.apiKey, now()),
    bridgeSecretMatches(secretHeader, settings.bridgeSecret),
  ])
  if (jwt !== true || secret !== true) {
    // No JWT at all: nothing recorded, no object call. Otherwise one closed stage (the JWT first), throttled per stage,
    // written after both checks; the answer is unchanged.
    if (!jwtHeader) return null
    const stage = jwt !== true ? 'jwt-bad' : !secretHeader ? 'secret-missing' : 'secret-bad'
    await noteProviderRefusal(env, stage, now())
    return null
  }
  return await bridgeStub(env).fetch(internalUpgrade('/voice-bridge/provider'))
}
