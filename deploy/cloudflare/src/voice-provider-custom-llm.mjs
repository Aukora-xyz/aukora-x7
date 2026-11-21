/** The VoiceBridge's FALLBACK provider adapter: the provider's Custom LLM HTTP shape (OpenAI-style chat completions).
 *
 * A TESTED SKELETON THAT REFUSES. It is not routed: no Worker path reaches it, so the provider cannot call it, and
 * `refuse()` is what a route would answer until it is finished. What is built: the same adapter interface as the Speech
 * Engine adapter (one bridge event list per request; the text a reply chunk and the end of a reply are written as),
 * the turn identity (the conversation plus the count and SHA-256 of the user messages; a request with more user
 * messages is the newer turn and supersedes the older), and the streaming answer's framing.
 * What is NOT built: the route, holding the HTTP stream open while her turn runs, and the authentication of the request
 * (the provider's documentation does not say which header carries the configured key: UNVERIFIED).
 * Sources: https://elevenlabs.io/docs/agents-platform/customization/llm/custom-llm (SSE `data:` chunks, `data: [DONE]`);
 * the conversation header is a variable-typed request header mapped to `system__conversation_id` (REPORTED by a third
 * party only; VOICE-PROVIDER.md section A).
 */

import { CONVERSATION_ID_RE, PROVIDER_HISTORY_MAX, PROVIDER_ENTRY_MAX_CHARS } from './voice-provider-speech-engine.mjs'

export const CUSTOM_LLM_ROUTES = Object.freeze(['/door/voice-llm', '/door/voice-llm/chat/completions'])
export const CUSTOM_LLM_CONVERSATION_HEADER = 'x-aukora-voice-conversation'
export const CUSTOM_LLM_MAX_BODY_BYTES = 262144
export const CUSTOM_LLM_READY = false

const encoder = new TextEncoder()
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
}

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(part => (isObject(part) && typeof part.text === 'string' ? part.text : '')).join('') : null

/** A request's bridge events: init for the conversation, then the transcript whose event id is the user-message count.
 * @param {string} bodyText The request body (already bounded by the caller).
 * @param {Headers} headers The request headers.
 * @returns {Promise<{events: object[], hash: string}|null>} null for anything outside the closed shape.
 */
export async function toBridgeEvents(bodyText, headers) {
  const conv = headers?.get?.(CUSTOM_LLM_CONVERSATION_HEADER)
  if (typeof conv !== 'string' || !CONVERSATION_ID_RE.test(conv)) return null
  if (typeof bodyText !== 'string' || encoder.encode(bodyText).byteLength > CUSTOM_LLM_MAX_BODY_BYTES) return null
  let body
  try { body = JSON.parse(bodyText) } catch { return null }
  if (!isObject(body) || body.stream !== true || !Array.isArray(body.messages) || body.messages.length > PROVIDER_HISTORY_MAX) return null
  const users = []
  for (const message of body.messages) {
    if (!isObject(message) || !['system', 'user', 'assistant'].includes(message.role)) return null
    const text = textOf(message.content)
    if (text === null) return null
    if (message.role === 'user') users.push(text)
  }
  if (!users.length) return null
  const text = users.at(-1).trim()
  return {
    // The history's shape as the speech-engine adapter says it (its last message's role; how many are his).
    events: [{ kind: 'init', conv }, { kind: 'transcript', eventId: users.length, text: text.length <= PROVIDER_ENTRY_MAX_CHARS ? text : '',
      tail: { user: 'user', assistant: 'agent' }[body.messages.at(-1).role], users: users.length }],
    hash: await sha256Hex(JSON.stringify(users)),
  }
}

/** The newer of two requests for one conversation: more user messages wins; equal counts with equal hashes are a retry. */
export function supersedes(newer, older) {
  if (newer.events[0].conv !== older.events[0].conv) return false
  return newer.events[1].eventId > older.events[1].eventId
}

export const chunk = (_eventId, content) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
export const final = _eventId => `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

/** What the door answers until the adapter is finished: a fixed refusal, nothing from the request echoed. */
export function refuse() {
  return Response.json({ ok: false, code: 'VOICE_ADAPTER_UNAVAILABLE' }, { status: 503, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

export const CUSTOM_LLM_ADAPTER = Object.freeze({ name: 'custom-llm', ready: CUSTOM_LLM_READY, toBridgeEvents, supersedes, chunk, final, refuse })
