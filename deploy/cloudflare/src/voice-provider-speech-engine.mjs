/** The VoiceBridge's PRIMARY provider adapter: the voice provider's Speech Engine upstream WebSocket.
 *
 * The provider owns the audio (microphone, recognition, turn-taking, interruption, her spoken voice) and opens a socket
 * to the edge's brain door; the words it speaks come from her own governed session through the bridge.
 * Wire shapes follow the provider's documented upstream protocol as the scout read it (VOICE-PROVIDER.md section A2,
 * https://elevenlabs.io/docs/api-reference/speech-engine/speech-engine-upstream.md). Every shape lives in this one file,
 * so a correction after the first real conversation is one edit. UNVERIFIED until a real conversation: the `type` field
 * name, whether `ping` carries an `event_id` to echo, the key the JWT is signed with (raw SHA-256 bytes of the account
 * key is assumed), and whether the header value carries a `Bearer ` prefix (both forms are accepted).
 *
 * The adapter interface the bridge uses (the Custom LLM fallback, voice-provider-custom-llm.mjs, has the same shape):
 *   parse(text) -> one bridge event, or null for a frame the bridge must refuse (it closes the socket):
 *     { kind: 'init', conv } | { kind: 'transcript', eventId, text, tail, users, agent } | { kind: 'ping', eventId } | { kind: 'close' } | { kind: 'error' }
 *     | { kind: 'other' } (2026-11-18: a frame of a type this file does not know, or a transcript with no event id; ignored)
 *     the voice fix: `tail` is 'user' when the history's last entry is his, 'agent' when it is hers, undefined otherwise (an
 *     empty history, another role); `users` is how many entries are his. The bridge uses both only to judge what is new
 *     (voice-bridge-do.mjs transcript); with neither it behaves as before.
 *     the voice fix: `agent` is HER last entry as the provider holds it (what it spoke of her reply; undefined when the
 *     history has none or it is over the entry bound), and `agentAfter` how many entries of his come before it. The
 *     bridge uses both only to pick her words up after a cut.
 *   chunk(eventId, content), final(eventId), pong(eventId) -> the text frame to send.
 */

export const SPEECH_ENGINE_AUTH_HEADER = 'x-elevenlabs-speech-engine-authorization'
export const SPEECH_ENGINE_ISSUER = 'https://api.elevenlabs.io/convai/speech-engine'
export const SPEECH_ENGINE_SUBJECT = 'convai_speech_engine_upstream'
export const SPEECH_ENGINE_SKEW_SECONDS = 60
/** The provider's per-attempt wait (its `cascade_timeout_seconds`); the bridge's slow-reply backchannel keys off it.
 * It must equal the provider-side setting (recommended 15 in VOICE-PROVIDER.md). */
export const SPEECH_ENGINE_TIMEOUT_SECONDS = 15
/** A provider frame carries the whole conversation's transcript, so its cap is larger than the tab's 8 KiB. */
export const PROVIDER_FRAME_MAX_BYTES = 262144
export const PROVIDER_HISTORY_MAX = 2000
/** The bound of his last entry as the provider sends it (it may hold several of his utterances merged; over
 * it the text is '', as before). The words of ONE turn keep the 4,000 bound (voice-bridge-do.mjs transcript). */
export const PROVIDER_ENTRY_MAX_CHARS = 32000
export const PROVIDER_TRANSCRIPT_MAX_CHARS = 4000
export const EVENT_ID_MAX = 1000000000
export const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,96}$/

const JWT_MAX_CHARS = 4096
const encoder = new TextEncoder()
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const eventIdOf = value => Number.isSafeInteger(value) && value >= 0 && value <= EVENT_ID_MAX ? value : null

function base64UrlBytes(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return null
  try {
    const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4))
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  } catch {
    return null
  }
}

function base64UrlJson(part) {
  const bytes = base64UrlBytes(part)
  if (!bytes) return null
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** The provider's upstream JWT: HS256, keyed with the SHA-256 of the account key, the documented issuer and subject,
 * a live `exp` and no `iat`/`nbf` in the future, each within 60 s of skew. Anything else (including no key) is false.
 * @param {string|null} headerValue The X-Elevenlabs-Speech-Engine-Authorization header.
 * @param {string} apiKey The managed voice's key (ELEVENLABS_VOICE_API_KEY when set, else ELEVENLABS_API_KEY).
 * @param {number} nowMs The edge clock.
 * @returns {Promise<boolean>} True only for a valid, current token.
 */
export async function verifySpeechEngineJwt(headerValue, apiKey, nowMs) {
  if (typeof headerValue !== 'string' || typeof apiKey !== 'string' || !apiKey || !Number.isFinite(nowMs)) return false
  const jwt = headerValue.replace(/^Bearer\s+/i, '')
  if (!jwt || jwt.length > JWT_MAX_CHARS) return false
  const parts = jwt.split('.')
  if (parts.length !== 3) return false
  const header = base64UrlJson(parts[0])
  const claims = base64UrlJson(parts[1])
  const signature = base64UrlBytes(parts[2])
  if (!header || !claims || !signature || header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT')) return false
  const now = Math.floor(nowMs / 1000)
  if (claims.iss !== SPEECH_ENGINE_ISSUER || claims.sub !== SPEECH_ENGINE_SUBJECT) return false
  if (!Number.isFinite(claims.exp) || claims.exp + SPEECH_ENGINE_SKEW_SECONDS <= now) return false
  for (const field of ['iat', 'nbf']) {
    if (claims[field] === undefined) continue
    if (!Number.isFinite(claims[field]) || claims[field] - SPEECH_ENGINE_SKEW_SECONDS > now) return false
  }
  const keyBytes = await crypto.subtle.digest('SHA-256', encoder.encode(apiKey))
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  return await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`))
}

/** The last user entry of the provider's transcript history, trimmed; '' when there is none or it is longer than
 * PROVIDER_ENTRY_MAX_CHARS. */
function lastUserText(history) {
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]
    if (!isObject(entry) || entry.role !== 'user') continue
    const text = typeof entry.content === 'string' ? entry.content.trim() : ''
    return text.length <= PROVIDER_ENTRY_MAX_CHARS ? text : ''
  }
  return ''
}

/** Who spoke the history's last entry ('user', 'agent', or undefined), and how many entries are his. The
 * provider documents the roles as exactly `user` and `agent`. */
function historyShape(history) {
  const last = history.at(-1)
  const tail = isObject(last) && (last.role === 'user' || last.role === 'agent') ? last.role : undefined
  return { tail, users: history.filter(entry => isObject(entry) && entry.role === 'user').length, ...lastAgent(history) }
}
/** Her last entry of the history, as the provider holds it (`agent`; undefined when there is none or it is too
 * long), and how many entries of his come before it (`agentAfter`): an entry that comes before the words she is answering
 * now is an OLDER reply and says nothing about this one. */
function lastAgent(history) {
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]
    if (!isObject(entry) || entry.role !== 'agent') continue
    const text = typeof entry.content === 'string' ? entry.content.trim() : ''
    if (!text || text.length > PROVIDER_ENTRY_MAX_CHARS) break
    return { agent: text, agentAfter: history.slice(0, index).filter(item => isObject(item) && item.role === 'user').length }
  }
  return { agent: undefined, agentAfter: undefined }
}

/** One provider frame to one bridge event, or null (the bridge closes the socket). 2026-11-18: a JSON object with a
 * string `type` this file does not know, and a `user_transcript` with no `event_id` at all (the provider's schema marks
 * it optional), are `{ kind: 'other' }`: the bridge ignores and counts them instead of closing the call over a frame the
 * provider may add or send without notice. Nothing of such a frame is kept. Every other unreadable frame stays null. */
export function parse(text) {
  if (typeof text !== 'string' || encoder.encode(text).byteLength > PROVIDER_FRAME_MAX_BYTES) return null
  let frame
  try { frame = JSON.parse(text) } catch { return null }
  if (!isObject(frame) || typeof frame.type !== 'string') return null
  switch (frame.type) {
    case 'init':
      return typeof frame.conversation_id === 'string' && CONVERSATION_ID_RE.test(frame.conversation_id) ? { kind: 'init', conv: frame.conversation_id } : null
    case 'user_transcript': {
      // No id to answer under: nothing can be said for it, so it is not a turn; a present but invalid id is refused.
      if (frame.event_id === undefined) return { kind: 'other' }
      const eventId = eventIdOf(frame.event_id)
      if (eventId === null || !Array.isArray(frame.user_transcript) || frame.user_transcript.length > PROVIDER_HISTORY_MAX) return null
      return { kind: 'transcript', eventId, text: lastUserText(frame.user_transcript), ...historyShape(frame.user_transcript) }
    }
    case 'ping':
      return { kind: 'ping', eventId: eventIdOf(frame.event_id) }
    case 'close':
      return { kind: 'close' }
    case 'error':
      return { kind: 'error' }
    default:
      return { kind: 'other' }
  }
}

export const chunk = (eventId, content) => JSON.stringify({ type: 'agent_response', content, event_id: eventId, is_final: false })
export const final = eventId => JSON.stringify({ type: 'agent_response', content: '', event_id: eventId, is_final: true })
export const pong = eventId => JSON.stringify(eventId === null ? { type: 'pong' } : { type: 'pong', event_id: eventId })

export const SPEECH_ENGINE_ADAPTER = Object.freeze({ name: 'speech-engine', parse, chunk, final, pong })
