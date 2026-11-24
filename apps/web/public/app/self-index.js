// Auma Live: A FEW FIXED QUESTIONS ABOUT HERSELF ARE ANSWERED FROM HER OWN INDEX.
//
// THE DESIGN: no pattern classifier sits in front of her model.
// A turn is taken only when the WHOLE normalised sentence equals one entry of a small closed list (SELF_QUESTIONS).
// Nothing else is ever taken: no name lookups, no aliases, no partial or unanchored match, no recall. Every other turn,
// and any doubt (an index or session list that does not answer), goes to her model untouched.
// The answers are built from what her runtime derives: the resident capability index (`x6_capability_index`) and the
// session index (`session/list`). Every answer carries `voiceAuthority: 'none'`, `mutating: false` and its sources.
// Nothing here writes, stages, promotes or approves anything.

export const SELF_ANSWER_SCHEMA = 'aukora.self-answer.v1'
export const CALL_TOOL_PATH = '/__x6__/call-tool'
const VOICE_TITLE = '[voice] Auma Live'
const MAX_LISTED = 12

/** @typedef {'thread' | 'epoch' | 'inventory'} SelfTopic */
/** @typedef {{ topic: SelfTopic, of?: 'tools' | 'organs' | 'capabilities' }} SelfAsk */
/** @typedef {{ sourceKind: string, trust: 'derived', ref: string, epoch?: number }} SelfSource */

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const short = (value, n = 8) => typeof value === 'string' ? value.replace(/^ball:/, '').slice(0, n) : ''
/** Real session ids are `session-<uuid>`: the spoken short form is the first eight characters AFTER that prefix. */
const shortSession = value => short(typeof value === 'string' ? value.replace(/^session-/, '') : value).toLowerCase()

/** THE closed list. A sentence is taken only if, normalised, it is exactly one of these keys. */
export const SELF_QUESTIONS = Object.freeze({
  'which epoch are you on': Object.freeze({ topic: 'epoch' }),
  'what epoch are you on': Object.freeze({ topic: 'epoch' }),
  'what tools do you have': Object.freeze({ topic: 'inventory', of: 'tools' }),
  'list your tools': Object.freeze({ topic: 'inventory', of: 'tools' }),
  'what organs do you have': Object.freeze({ topic: 'inventory', of: 'organs' }),
  'list your organs': Object.freeze({ topic: 'inventory', of: 'organs' }),
  'what are your capabilities': Object.freeze({ topic: 'inventory', of: 'capabilities' }),
  'what did we do in our last thread': Object.freeze({ topic: 'thread' }),
  'what was our last thread': Object.freeze({ topic: 'thread' }),
})

/**
 * Lowercase, collapse spaces, trim, strip trailing punctuation, drop one leading "auma," / "hey auma," / "please".
 * @param {unknown} text
 */
export function normalizeSelfQuestion(text) {
  let q = clean(text).toLowerCase().replace(/[\s?!.,;:]+$/u, '').trim()
  q = q.replace(/^(?:hey |hi |ok |okay )?auma[,\s]+/u, '').trim()
  q = q.replace(/^please[,\s]+/u, '').trim()
  return q
}

/**
 * The fixed self-question this sentence is, or null. Exact equality with a closed-list key; nothing else.
 * @param {unknown} text
 * @returns {SelfAsk | null}
 */
export function classifySelfQuestion(text) {
  const q = normalizeSelfQuestion(text)
  return Object.hasOwn(SELF_QUESTIONS, q) ? { ...SELF_QUESTIONS[q] } : null
}

function indexSource(index) {
  return { sourceKind: 'capability-index', trust: 'derived', ref: `epoch ${index.epoch} · ball ${short(index.ballId, 16)} · digest ${short(index.digest, 16)}`, epoch: index.epoch }
}

function answer(status, code, topic, text, sources, extra = {}) {
  return Object.freeze({
    schema: SELF_ANSWER_SCHEMA, voiceAuthority: 'none', mutating: false,
    status, code, topic, text, sources: Object.freeze(sources.map(source => Object.freeze({ ...source }))), ...extra,
  })
}

/**
 * WHAT IS SPOKEN IS A TEMPLATE: fixed words around identifiers and numbers from the index only.
 * Free text of any kind (thread titles, descriptions) is never spoken; it is in the transcript, and she says so. An
 * identifier is spoken only if the page's speech sanitizer leaves it byte for byte (lower kebab: no underscore, which the
 * sanitizer strips), so the spoken output equals the template output exactly.
 */
const SPEAKABLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A session id is spoken only as EXACTLY eight permitted characters ("hi" was spoken). */
const SESSION_PREFIX = /^[a-z0-9-]{8}$/
/** The longest her index read may take; past it the turn goes to her model untouched. */
export const SELF_INDEX_READ_MS = 2500

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function ago(ms, now) {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 90) return `${m} minutes ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} hours ago`
  return `${Math.round(h / 24)} days ago`
}

/**
 * Answer one fixed self-question from gathered facts. Pure: no I/O, no clock beyond `facts.now`.
 * @param {SelfAsk} ask
 * @param {{ index?: any, indexError?: string, sessions?: any[] | null, excludeSessionIds?: string[], now?: number }} facts
 */
export function answerSelfQuestion(ask, facts = {}) {
  const topic = ask?.topic
  // An injected Infinity would be spoken as "Infinity days ago"; only a whole, finite clock is used.
  const now = Number.isSafeInteger(facts.now) && facts.now >= 0 ? facts.now : Date.now()

  if (topic === 'thread') {
    const exclude = new Set((facts.excludeSessionIds ?? []).filter(Boolean))
    const sessions = Array.isArray(facts.sessions) ? facts.sessions : null
    // An index that did not answer is doubt, not an answer: the turn goes to her untouched.
    if (!sessions) return answer('pass', 'SESSION_INDEX_UNAVAILABLE', topic, '', [])
    const last = sessions.filter(item => item && typeof item.sessionId === 'string' && item.sessionId
      && item.blank !== true && item.origin !== 'subagent' && !exclude.has(item.sessionId)
      && item.title !== VOICE_TITLE && item.displayTitle !== VOICE_TITLE && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!last) {
      return answer('refused', 'THREAD_UNRESOLVED', topic, "I can't resolve that: my session index has no earlier thread.", [],
        { spoken: "I can't resolve that: my session index has no earlier thread." })
    }
    const title = clean(last.title || last.displayTitle)
    return answer('sourced', 'THREAD_RESOLVED', topic,
      `The last thread was ${title ? `“${title}”` : 'an untitled thread'}, active ${ago(last.updatedAt, now)}. My session index names it, but not what was said inside it.`,
      [{ sourceKind: 'session-index', trust: 'derived', ref: `session ${last.sessionId}` }],
      { resolved: Object.freeze({ sessionId: last.sessionId, title, updatedAt: last.updatedAt }),
        spoken: `The last thread is session ${SESSION_PREFIX.test(shortSession(last.sessionId)) ? shortSession(last.sessionId) : 'with an unusual id'}, active ${ago(last.updatedAt, now)}.${title ? ' Its title is in the transcript.' : ' It has no title.'}` })
  }

  // Only a whole, finite, non-negative epoch is ever spoken (an overflow could say "Infinity").
  const index = facts.index && typeof facts.index === 'object' && Number.isSafeInteger(facts.index.epoch) && facts.index.epoch >= 0 ? facts.index : null
  // An unreachable index is doubt, not an answer: the turn goes to her model untouched (she has her own tools).
  if (!index) return answer('pass', 'INDEX_UNAVAILABLE', topic ?? 'unknown', '', [])
  const at = indexSource(index)
  const tools = Array.isArray(index.registeredTools) ? index.registeredTools : []
  const organs = Array.isArray(index.organs) ? index.organs : []

  if (topic === 'epoch') {
    const said = `I'm at epoch ${index.epoch}, with ${plural(organs.length, 'organ')} in my head.`
    return answer('sourced', 'EPOCH', topic, said, [at], { spoken: said })
  }
  if (topic === 'inventory') {
    const live = organs.filter(organ => organ.disabled !== true).map(organ => organ.id)
    const ro = tools.filter(tool => tool.readOnly === true).length
    const toolLine = `${plural(tools.length, 'registered tool')}, ${ro} read-only and ${tools.length - ro} that can change things`
    // The WRITTEN answer holds everything the spoken one says is in the transcript: every
    // tool name and the complete organ list, never cut.
    const toolNames = tools.map(tool => String(tool.name))
    const toolsWritten = `Tools: ${toolNames.join(', ') || 'none'}.`
    const organsWritten = `Organs: ${live.join(', ') || 'none'}.`
    const text = ask.of === 'tools' ? `I have ${toolLine}, at epoch ${index.epoch}. ${toolsWritten}`
      : ask.of === 'organs' ? `I have ${plural(live.length, 'mounted organ')}, at epoch ${index.epoch}. ${organsWritten}`
        : `I have ${toolLine}, and ${plural(live.length, 'mounted organ')}, at epoch ${index.epoch}. ${toolsWritten} ${organsWritten}`
    const speakable = live.filter(id => SPEAKABLE_ID.test(id))
    const shown = speakable.slice(0, MAX_LISTED)
    const restInTranscript = live.length > shown.length
    const toolSaid = `I have ${toolLine}, at epoch ${index.epoch}.`
    const organSaid = `I have ${plural(live.length, 'mounted organ')}${shown.length ? `, among them ${shown.join(', ')}` : ''}, at epoch ${index.epoch}.`
      + (restInTranscript ? ' The full list is in the transcript.' : '')
    const spoken = ask.of === 'tools' ? `${toolSaid} Their names are in the transcript.`
      : ask.of === 'organs' ? organSaid
        : `${toolSaid} ${organSaid}${restInTranscript ? '' : ' The tool names are in the transcript.'}`
    return answer('sourced', 'INVENTORY', topic, text, [at], { spoken })
  }
  return answer('pass', 'NOT_A_SELF_QUESTION', topic ?? 'unknown', '', [])
}

/**
 * Would the page's speech sanitizer (aumalive.js `sanitizeForVoice`) DELETE words from this text? It drops code fences
 * with their content, images, and her invisible tags; markers such as * _ # only lose the symbol.
 * @param {string} text
 */
export function speechWouldDelete(text) {
  return /```|!\[[^\]]*\]\(|\[\s*(?:field|repo|web|recall|weights)\b[^\]]*\]/i.test(String(text ?? ''))
}

const SPOKEN_KIND = {
  'capability-index': 'my capability index',
  'session-index': 'my session index',
}

/**
 * Words for one channel. The facts and the sources are the answer's, unchanged.
 * @param {ReturnType<typeof answerSelfQuestion>} result
 * @param {'spoken' | 'written'} channel
 */
export function renderSelfAnswer(result, channel) {
  const kinds = [...new Set(result.sources.map(source => source.sourceKind))]
  if (channel === 'spoken') {
    // Only the template is ever spoken; an answer without one says nothing beyond where to look.
    const said = typeof result.spoken === 'string' ? result.spoken : 'The detail is in the transcript.'
    if (kinds.length === 0) return said
    return `${said} That comes from ${kinds.map(kind => SPOKEN_KIND[kind] ?? `my ${kind.replace(/[-_]/g, ' ')}`).join(' and ')}.`
  }
  if (result.sources.length === 0) return result.text
  return `${result.text}\nSources: ${result.sources.map(source => `${source.sourceKind} (${source.trust}): ${source.ref}`).join('; ')}`
}

/** The tool output a `/__x6__/call-tool` body carries: `raw` when it is an object, else the parsed `output`. */
export function toolOutput(body) {
  if (!body || body.ok !== true) return null
  if (body.raw && typeof body.raw === 'object') return body.raw
  try { return typeof body.output === 'string' ? JSON.parse(body.output) : null } catch { return null }
}

/**
 * Reads her runtime through the page's DSH transport: the capability index or the session list, one read per question.
 * Never throws: a failed read is a fact the answer states (as a pass).
 * @param {{ transport: () => any, now?: () => number }} deps
 */
export function createSelfIndexReader({ transport, now = Date.now, readTimeoutMs = SELF_INDEX_READ_MS }) {
  async function post(path, body, signal) {
    const carrier = await transport()
    signal?.throwIfAborted()
    if (!carrier || typeof carrier.fetch !== 'function') throw new Error('DSH transport is unavailable')
    const response = await carrier.fetch(path, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    // A body that is not JSON is a failed read, never an empty answer.
    return { status: response.status, body: await response.json() }
  }
  async function callTool(name, args, signal) {
    const { status, body } = await post(CALL_TOOL_PATH, { name, args }, signal)
    if (status !== 200) throw new Error(typeof body?.error === 'string' ? body.error.slice(0, 160) : `call-tool ${name} answered ${status}`)
    const out = toolOutput(body)
    if (!out) throw new Error(`call-tool ${name} returned no output`)
    return out
  }
  async function listSessions(signal) {
    const { status, body } = await post('/api/session/list', {
      type: 'client-request', rpcId: `self-index-${now()}`, method: 'session/list', payload: { args: { _request: {} } },
    }, signal)
    const result = body?.result ?? body
    // Only a successful answer with a real items array counts; a malformed 200 is a failed read,
    // so it can never be heard as "no earlier thread".
    const items = result?.value?.items
    if (status !== 200 || !result || result.ok === false || !Array.isArray(items)
      || items.some(item => item === null || typeof item !== 'object' || Array.isArray(item)
        // An entry without a real id, or with an updatedAt that is not a whole number, is a
        // malformed answer too ({}; a numeric sessionId; a string updatedAt), never "no earlier thread".
        || typeof item.sessionId !== 'string' || !item.sessionId
        || (item.updatedAt !== undefined && (!Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0)))) throw new Error('session/list answer invalid')
    return items
  }
  /**
   * One bounded read. The whole read (transport, request, body) has a deadline; past it, or on any failure, the facts
   * are empty and the answer passes the turn to her model. The caller's signal (a barge-in) aborts it at once.
   * @param {SelfAsk} ask
   * @param {{ signal?: AbortSignal, excludeSessionIds?: string[] }} options
   */
  async function gather(ask, { signal, excludeSessionIds = [] } = {}) {
    const facts = { now: now(), excludeSessionIds, index: null, sessions: null }
    const controller = new AbortController()
    // The internal listener is attached BEFORE a caller signal that is already aborted is relayed, so a pre-aborted
    // read ends at once instead of waiting for the deadline.
    let rejectAborted
    const aborted = new Promise((_resolve, reject) => { rejectAborted = reject })
    const onAbort = () => rejectAborted(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const stop = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    let timer
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(new Error('SELF_INDEX_READ_TIMEOUT')); reject(new Error('SELF_INDEX_READ_TIMEOUT')) }, readTimeoutMs)
    })
    void deadline.catch(() => {})
    void aborted.catch(() => {})
    const bounded = operation => Promise.race([operation(controller.signal), deadline, aborted])
    try {
      if (ask.topic === 'thread') facts.sessions = await bounded(listSessions)
      else facts.index = await bounded(sig => callTool('x6_capability_index', { action: 'snapshot' }, sig))
    } catch (error) {
      if (ask.topic === 'thread') facts.sessions = null
      else facts.index = null
      facts.readError = error instanceof Error ? error.message : String(error)
      if (facts.readError === 'SELF_INDEX_READ_TIMEOUT') facts.timedOut = true
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      controller.signal.removeEventListener('abort', onAbort)
    }
    return facts
  }
  return { gather, callTool, listSessions }
}

/**
 * One self-question, start to end: classify, gather, answer. `null` when the words are not on the closed list.
 * @param {string} text
 * @param {{ reader: ReturnType<typeof createSelfIndexReader>, signal?: AbortSignal, excludeSessionIds?: string[] }} options
 */
export async function answerFromSelfIndex(text, { reader, signal, excludeSessionIds } = {}) {
  const ask = classifySelfQuestion(text)
  if (!ask) return null
  const facts = await reader.gather(ask, { signal, excludeSessionIds })
  return answerSelfQuestion(ask, facts)
}
