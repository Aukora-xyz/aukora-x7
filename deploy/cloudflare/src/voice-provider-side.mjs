/**
 * WHAT THE PROVIDER SAYS ABOUT ITS OWN SIDE, for the owner's status read.
 *
 * Why: on 2026-11-18 every call connected and was ended by the provider about two seconds later. The edge refused
 * nothing and held no record of why, because the reason lives at the provider: its account (credits, a plan limit) and
 * its own record of each conversation (how it ended, with what error). Nobody on the owner's side could read either
 * without opening the provider by hand, and hours went to guessing. This file reads both, best effort, when the owner
 * asks for the managed voice's status.
 *
 * What it reads, with the managed voice's own key (the one the edge already uses for the token and the resource read),
 * all GET, all from https://api.elevenlabs.io, under ONE deadline (PROVIDER_SIDE.deadlineMs):
 *   1. GET /v1/user/subscription: the account's state, the credits used and the credit limit, whether it may go over.
 *   2. GET /v1/convai/conversations?agent_id=<resource>&page_size=N: the resource's newest conversations (when each
 *      started, how long it lasted, its state).
 *   3. GET /v1/convai/conversations/{id} for the newest few of those: `metadata.termination_reason` and
 *      `metadata.error` (the provider's own words for why it ended) and `metadata.warnings`.
 * Field names: the provider's reference, read 2026-11-18 (api-reference/user/subscription/get, conversations/list,
 * conversations/get). UNVERIFIED against the live answers until the first read in production.
 *
 * What it keeps: numbers, booleans, closed words, and the provider's reason texts cut to PROVIDER_SIDE.textChars and
 * to a plain alphabet (providerWords). NEVER a transcript, a conversation id, a key, a name or a url. A conversation's
 * body holds what was said: it is parsed here and everything but the few fields above is dropped at once.
 *
 * The provider's reason text is the provider's words, not the edge's and not the owner's: whoever reads the status
 * (her status tool included) must treat it as data.
 *
 * Every read answers with a closed `read` word (PROVIDER_SIDE_READS) so a refused or failed read is told apart from an
 * empty one. Nothing here throws, nothing is stored, and the status answers without this block when the switch is off.
 */
export const PROVIDER_SIDE = Object.freeze({ origin: 'https://api.elevenlabs.io', deadlineMs: 5000, listed: 6, detailed: 3, bodyBytes: 262144, textChars: 160, warnings: 3 })
export const PROVIDER_SIDE_READS = Object.freeze(['ok', 'status-401', 'status-403', 'status-404', 'status-429', 'status-5xx', 'status-other', 'timeout', 'network', 'shape', 'too-large', 'not-asked'])
export const SUBSCRIPTION_STATUSES = Object.freeze(['trialing', 'active', 'incomplete', 'past_due', 'free', 'free_disabled'])
export const CONVERSATION_STATUSES = Object.freeze(['initiated', 'in-progress', 'processing', 'done', 'failed'])
export const CONVERSATION_RESULTS = Object.freeze(['success', 'failure', 'unknown'])

const RESOURCE_RE = /^(?:agent|seng)_[A-Za-z0-9]{1,64}$/
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,96}$/
const WORD_RE = /^[a-z0-9_-]{1,32}$/
const decoder = new TextDecoder('utf-8', { fatal: true })
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const whole = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const flag = value => (typeof value === 'boolean' ? value : null)
const oneOf = (list, value) => (list.includes(value) ? value : null)
const word = value => (typeof value === 'string' && WORD_RE.test(value) ? value : null)

/** The provider's own words, made safe to show: letters, digits, spaces and plain punctuation only, one space between
 * words, cut to `max`. Anything else (a non-string, or nothing left) is null. */
export function providerWords(value, max = PROVIDER_SIDE.textChars) {
  if (typeof value !== 'string') return null
  const text = value.replace(/[^A-Za-z0-9 .,:;'()_/-]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
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

const statusRead = status => (status === 401 || status === 403 || status === 404 || status === 429 ? `status-${String(status)}` : status >= 500 && status <= 599 ? 'status-5xx' : 'status-other')

/** One GET. Answers { read, value }: `read` is a word of PROVIDER_SIDE_READS and `value` the parsed JSON only for 'ok'. */
async function getJson(networkFetch, path, apiKey, signal) {
  let response
  try {
    response = await networkFetch(PROVIDER_SIDE.origin + path, { method: 'GET', headers: { 'xi-api-key': apiKey }, redirect: 'manual', signal })
  } catch {
    return { read: signal.aborted ? 'timeout' : 'network', value: null }
  }
  try {
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {})
      return { read: response.redirected ? 'status-other' : statusRead(response.status), value: null }
    }
    const length = response.headers.get('content-length')
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => {})
      return { read: 'shape', value: null }
    }
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > PROVIDER_SIDE.bodyBytes)) {
      await response.body?.cancel().catch(() => {})
      return { read: 'too-large', value: null }
    }
    let bytes
    try {
      bytes = await readBounded(response, PROVIDER_SIDE.bodyBytes)
    } catch {
      return { read: signal.aborted ? 'timeout' : 'too-large', value: null }
    }
    return { read: 'ok', value: JSON.parse(decoder.decode(bytes)) }
  } catch {
    return { read: signal.aborted ? 'timeout' : 'shape', value: null }
  }
}

/** The account, closed: its state, its plan word, credits used and the limit, whether it may go over, open invoices. */
export function readSubscription(value) {
  if (!isObject(value)) return null
  return { status: oneOf(SUBSCRIPTION_STATUSES, value.status), tier: word(value.tier), used: whole(value.character_count), limit: whole(value.character_limit),
    canGoOver: flag(value.can_extend_character_limit), openInvoices: flag(value.has_open_invoices), resetAtSeconds: whole(value.next_character_count_reset_unix) }
}

/** One conversation of the list, closed. Its id is used to read its end reason and is never returned. */
function readListed(item) {
  if (!isObject(item) || typeof item.conversation_id !== 'string' || !CONVERSATION_ID_RE.test(item.conversation_id)) return null
  return { id: item.conversation_id, row: { startedAtSeconds: whole(item.start_time_unix_secs), durationSeconds: whole(item.call_duration_secs), messages: whole(item.message_count),
    status: oneOf(CONVERSATION_STATUSES, item.status), result: oneOf(CONVERSATION_RESULTS, item.call_successful) } }
}

/** How one conversation ended, in the provider's words: only these fields are read out of its body. */
export function readEnding(value) {
  if (!isObject(value)) return null
  const meta = isObject(value.metadata) ? value.metadata : {}
  const error = isObject(meta.error) ? meta.error : null
  const warnings = Array.isArray(meta.warnings) ? meta.warnings.slice(0, PROVIDER_SIDE.warnings).map(item => providerWords(item)).filter(item => item !== null) : []
  return { status: oneOf(CONVERSATION_STATUSES, value.status), endReason: providerWords(meta.termination_reason),
    errorCode: error && Number.isSafeInteger(error.code) ? error.code : null, errorReason: error ? providerWords(error.reason) : null, warnings }
}

/** The block the status shows when nothing was asked (the switch off, no key, no resource, no transport). */
export const providerSideNotAsked = at => ({ readAtMs: at, account: { read: 'not-asked' }, conversations: { read: 'not-asked', rows: [] } })

/**
 * The three reads, best effort, under one deadline. Never throws.
 * @param {object} options networkFetch (the edge's public HTTPS transport), apiKey, resourceId, now, deadlineMs (tests).
 * @returns {Promise<object>} { readAtMs, account: { read, ...readSubscription }, conversations: { read, rows: [{ startedAtSeconds,
 *   durationSeconds, messages, status, result, ending: { read, ...readEnding } }] } }, newest first as the provider lists them.
 */
export async function readProviderSide({ networkFetch, apiKey, resourceId, now = Date.now, deadlineMs = PROVIDER_SIDE.deadlineMs }) {
  const at = now()
  const out = providerSideNotAsked(at)
  if (typeof networkFetch !== 'function' || typeof apiKey !== 'string' || !apiKey || typeof resourceId !== 'string' || !RESOURCE_RE.test(resourceId)) return out
  try {
    const signal = AbortSignal.timeout(deadlineMs)
    const [account, list] = await Promise.all([
      getJson(networkFetch, '/v1/user/subscription', apiKey, signal),
      getJson(networkFetch, `/v1/convai/conversations?agent_id=${encodeURIComponent(resourceId)}&page_size=${String(PROVIDER_SIDE.listed)}`, apiKey, signal),
    ])
    const subscription = account.read === 'ok' ? readSubscription(account.value) : null
    out.account = account.read !== 'ok' ? { read: account.read } : subscription ? { read: 'ok', ...subscription } : { read: 'shape' }
    if (list.read !== 'ok') { out.conversations = { read: list.read, rows: [] }; return out }
    if (!isObject(list.value) || !Array.isArray(list.value.conversations)) { out.conversations = { read: 'shape', rows: [] }; return out }
    const listed = list.value.conversations.slice(0, PROVIDER_SIDE.listed).map(readListed).filter(item => item !== null)
    const endings = await Promise.all(listed.map((item, index) => (index < PROVIDER_SIDE.detailed
      ? getJson(networkFetch, `/v1/convai/conversations/${encodeURIComponent(item.id)}`, apiKey, signal)
      : Promise.resolve({ read: 'not-asked', value: null }))))
    out.conversations = { read: 'ok', rows: listed.map((item, index) => {
      const got = endings[index]
      const ending = got.read === 'ok' ? readEnding(got.value) : null
      return { ...item.row, ending: got.read !== 'ok' ? { read: got.read } : ending ? { read: 'ok', ...ending } : { read: 'shape' } }
    }) }
    return out
  } catch {
    return out
  }
}
