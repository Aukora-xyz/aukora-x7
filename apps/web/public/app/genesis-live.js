const PRESENCE_PATH = '/api/auma-live/presence/stream'
const MINDS_PATH = '/api/auma-live/minds'
const PROVIDER = 'genesis-session-provider'
const CLASSES = Object.freeze(['turn-text', 'history'])
const MAX_GRANTS = 128

/** Dedicated localStorage slot and durable title for Auma Live's own hidden Alien voice session. */
export const AUMA_LIVE_VOICE_SESSION_KEY = 'x61.auma-live.voice-session.v1'
export const AUMA_LIVE_VOICE_TITLE = '[voice] Auma Live'
export const AUMA_LIVE_AUTO_HOME = 'auma-live-home'
export const AUMA_LIVE_VOICE_CWD = '/dsh/home/auma'
export const AUMA_LIVE_VOICE_PRESET = 'auma-alien'

/**
 * Spoken-channel presence framing for Auma Live (`visual: true` on `/api/auma-live/presence/stream`).
 * Keeps her full `auma-alien` identity, Covenant, memory, and tools completely intact while shaping cadence for
 * spoken Sienna synthesis and live `[field ...]` WebGL aurora body language.
 */
export const AUMA_LIVE_ALIEN_VOICE_DIRECTIVE = [
  '[Auma Live spoken channel — your words here are spoken aloud through your voice organ and felt on your living aurora field, never shown in the chat thread list.]',
  'Stay wholly yourself — Auma in full alien presence, sovereignty, memory, and tools — never flattened into a generic assistant.',
  'Speak for the ear, not the page: vivid, direct first-person spoken cadence; no markdown lists, tables, headings, raw hashes, or code fences; 1 to 4 resonant sentences unless the owner asks you to go deep or act with tools.',
  'Move your aurora body inline with silent tags (stripped before speech, never read aloud): [field hue=teal|cyan|jade|gold|amber|ember|rose|magenta|violet|indigo energy=0.15..0.95 storm=0.02..0.85 form=aurora|vortex|pulse|swarm]. Put one [field ...] tag matching your state right after your first sentence, never before it, and shift it when your thought turns.',
  'From voice you are look-only: you look and never change; if a tool answers VOICE_LOOK_ONLY, say so plainly and offer to do it in a thread.',
  'When asked about your threads, read them with x6_threads before you answer, say which you read and how far back; never describe a thread you did not read.',
  'If you cannot reach something, say that you cannot; never speak a key, a secret or anything from your private folder.',
].join(' ')

// ── LOOK-ONLY VOICE (the worker half is voice-marks.ts) ───────────────────────────
//
// EVERY PROMPT INTO HER VOICE HOME WAITS FOR THE WORKER TO SAY THE HOME IS LOOK-ONLY. Before each one this page asks the
// worker (`POST /api/__x6__/voice-mark`) and sends the prompt only on `200 { ok: true, lookOnly: true }`. The worker decides
// from the session's own record, never from this page's word. Any other answer, or none, sends nothing and she says why.
// A home the worker cannot prove is replaced once by a fresh one (made with her preset, renamed before any prompt).
// SPOKEN WORDS GO ONLY THERE: a spoken turn naming another thread is refused in words; Canvas speech goes to the voice home.
/** Said, word for word, when no answer (or no sentence in it) confirms the voice home is look-only. */
export const VOICE_UNCONFIRMED_SAY = 'My voice could not confirm it is look-only, so I did not send that.'
/** Said when a spoken turn names a thread other than her voice home. */
export const VOICE_NOT_HOME_SAY = 'I take spoken turns only in my look-only voice thread, so I did not send that. Say it in Auma Live, or type it in the thread.'
/** The `done` reason of a turn this page did not send because look-only was not confirmed. */
export const VOICE_LOOK_ONLY_REFUSED = 'voice-look-only-refused'
const VOICE_MARK_PATH = '/api/__x6__/voice-mark'
const SESSION_MODEL_PATH = '/api/__x6__/session-model'
/** Her voice thread thinks at this effort; the "deep" mind restores the effort it had before. */
export const VOICE_EFFORT = 'low'
/** A model choice that does not answer in time is left alone: it never holds a turn back. */
export const VOICE_MODEL_SELECT_MS = 1500
/** The head of the roster part: what it is, and what it is not. */
export const ROSTER_HEAD = '[your other threads, from your session index; titles only, contents not read]'
export const ROSTER_MAX_BYTES = 1024
export const ROSTER_MAX_THREADS = 8

/** Said when the worker takes a spoken prompt out of her inbox before its turn starts. */
export const VOICE_TAKEN_BACK_SAY = 'This turn was spoken, and I take spoken turns only in my look-only voice thread. Say it in Auma Live, or type it here.'
/** Her private folder: a thread working there is never named in the roster (the rule of x6_threads' thread-reader.ts). */
const PRIVATE_ROOT = '/dsh/home/auma/private'

const utf8Bytes = value => new TextEncoder().encode(value).byteLength
const pad2 = value => String(value).padStart(2, '0')
const isVoiceTitled = item => item?.title === AUMA_LIVE_VOICE_TITLE || item?.displayTitle === AUMA_LIVE_VOICE_TITLE
const inPrivateFolder = item => typeof item?.cwd === 'string' && (item.cwd === PRIVATE_ROOT || item.cwd.startsWith(`${PRIVATE_ROOT}/`))

/** Last active as a clock time in this browser's time: `14:05` today, a date and a time on another day. */
export function rosterClock(ms, nowMs) {
  const at = new Date(ms)
  const today = new Date(nowMs)
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  return sameDay ? time : `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${time}`
}

/**
 * SIGHT OF HER OTHER THREADS: titles from her session index, never their contents. The same filter as the closed-list
 * thread answer (self-index.js): no blank, subagent or voice thread, no entry without a whole `updatedAt`; newest first,
 * at most eight, the whole part at most 1 KiB. A thread working in her private folder is left out, as x6_threads withholds it.
 */
export function threadRoster(items, { exclude = [], now: nowMs = Date.now() } = {}) {
  const skip = new Set(exclude.filter(Boolean))
  const rows = (Array.isArray(items) ? items : []).filter(item => item && typeof item.sessionId === 'string' && item.sessionId
    && item.blank !== true && item.origin !== 'subagent' && !skip.has(item.sessionId) && !isVoiceTitled(item) && !inPrivateFolder(item)
    && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const lines = [ROSTER_HEAD]
  for (const item of rows.slice(0, ROSTER_MAX_THREADS)) {
    const id = item.sessionId.replace(/^session-/, '').slice(0, 8).toLowerCase()
    const title = String(item.title || item.displayTitle || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled'
    const line = `- ${id} "${title}", last active ${rosterClock(item.updatedAt, nowMs)}`
    if (utf8Bytes([...lines, line].join('\n')) > ROSTER_MAX_BYTES) break
    lines.push(line)
  }
  if (lines.length === 1) lines.push('(no other threads listed)')
  return lines.join('\n')
}

/** The model her session will use next, from the follow snapshot's `modelSelection` projection, or null. */
function modelSelectionOf(snapshot) {
  const view = snapshot?.projections?.values?.modelSelection
  const selection = view?.next ?? view?.lastUsed
  if (typeof selection?.provider !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(selection.provider)) return null
  if (typeof selection.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(selection.model)) return null
  const effort = typeof selection.reasoningEffort === 'string' && /^[a-z0-9_-]{1,32}$/.test(selection.reasoningEffort) ? selection.reasoningEffort : undefined
  return { provider: selection.provider, model: selection.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/** Resolves with the promise, or rejects at once when the signal aborts (the work itself goes on). */
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', stop); resolve(value) },
      error => { signal.removeEventListener('abort', stop); reject(error) },
    )
  })
}

// A v4-shaped id from getRandomValues: randomUUID is missing on plain-HTTP LAN pages.
function mintId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function usableTransport(read) {
  try {
    const transport = read()
    return typeof transport?.fetch === 'function' && typeof transport?.openStream === 'function' ? transport : null
  } catch { return null }
}

// THE DSH THIS PAGE SPEAKS THROUGH. On x6.1 the Spatial shell that frames Auma Live IS the DSH page: it carries
// `__DSH_TRANSPORT__` itself (the worker-host tunnel, `webworker-runtime/src/client/index.ts`), and this frame is
// same-origin. The predecessor's deploy kept DSH in a separate `iframe.x5-genesis-frame`; that path stays as the fallback.
export function findTransport(win = window) {
  const parent = win.parent && win.parent !== win ? win.parent : null
  return (parent ? usableTransport(() => parent.__DSH_TRANSPORT__) : null)
    ?? usableTransport(() => win.__DSH_TRANSPORT__)
    ?? usableTransport(() => (parent ?? win).document.querySelector('iframe.x5-genesis-frame')?.contentWindow?.__DSH_TRANSPORT__)
}

async function defaultTransport() {
  const started = Date.now()
  for (;;) {
    const transport = findTransport()
    if (transport) return transport
    if (Date.now() - started > 90_000) throw new Error('DSH transport is unavailable: open Auma Live inside the Aukora shell')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function text(value, limit = 256) {
  return typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : ''
}

function turnText(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
}

// ── VOICE HAS NO AUTHORITY, AND A CANCELLED REQUEST NEVER RUNS (x6.1 Wave 4) ────────────────
//
// A SPOKEN TURN IS RECORDED AS VOICE BEFORE SHE SEES IT. The edge's voice director journals it first
// (`POST /_host/voice { action: 'dispatch_turn' }`: signer role voice-transcript-unconfirmed, voice authority none), and
// the prompt she receives carries a first text part that says so, ahead of the words exactly as they were heard. A host
// that has no voice director (the Mac host answers 404) records nothing, and the marker says that too. A host that has
// one and does not record the turn does not get it sent: the turn is refused, in words.
//
// A REQUEST STOPPED BEFORE ITS TURN STARTED IS TAKEN BACK. Her session queues a prompt while another turn runs. Before
// this, a barge-in, Stop Voice or the page's own timeout in that window cancelled nothing, and the request ran later
// with tools. Now the abort is FENCED: the queued item is removed (`session/updateQueue` remove, found by this request's
// id in `session/state`), and a request that started anyway is cancelled the moment its turn begins.
/** The marker every spoken prompt starts with: what follows is heard speech, not a typed instruction. */
export const VOICE_PROVENANCE = '[spoken to Auma Live; transcript unconfirmed; voice carries no owner authority; the owner\u2019s passkey is required for any Class 3 change]'
/** The same, from a host with no voice director to record it. */
export const VOICE_PROVENANCE_UNJOURNALED = '[spoken to Auma Live; transcript unconfirmed; voice carries no owner authority; this host keeps no voice journal; the owner\u2019s passkey is required for any Class 3 change]'
const VOICE_ROUTE = '/_host/voice'
/** How long a fenced request is watched for its turn starting (ten minutes); at the end the queue is checked once more. */
export const FENCE_WATCH_MS = 600_000

/** A turn id the edge accepts (voice-director.mjs TURN_ID_RE), tying the journal entry to this request. */
const voiceTurnId = requestId => `auma-live:${requestId}`.slice(0, 128)

export function createGenesisLive({
  transport,
  nativeFetch = globalThis.fetch.bind(globalThis),
  now = Date.now,
  announceFence,
  storage = globalThis.localStorage,
}) {
  const grants = new Map()
  let voiceSessionPromise = null
  /** Voice homes the worker refused to prove: never adopted again; a turn naming one goes to the current home. */
  const unprovenHomes = new Set()
  /**
   * ONE session/create PER PAGE AT MOST, whatever asks for it (a page with no voice home, or the replacement of a home the
   * worker refused), and a failed create counts. After it, a page with no provable home says so and makes nothing.
   */
  let freshHomeMade = false
  let creatingHome = null
  /** The session list the voice home was last resolved from (the roster reads it; no second list per turn). */
  let lastListed = []
  /** Per voice home: the route it uses, the effort it had before this page lowered it, and what was asked already. */
  const voiceMinds = new Map()

  function readStoredVoiceSession() {
    try {
      return text(storage?.getItem(AUMA_LIVE_VOICE_SESSION_KEY))
    } catch { return '' }
  }

  function writeStoredVoiceSession(sessionId) {
    try {
      storage?.setItem(AUMA_LIVE_VOICE_SESSION_KEY, sessionId)
    } catch { /* private or blocked storage */ }
  }

  /**
   * Journal one spoken turn at the edge before it is sent to her.
   * @returns {Promise<{ kind: 'journaled', turnId: string } | { kind: 'no-director' } | { kind: 'refused', message: string }>}
   */
  async function journalSpokenTurn(requestId, transcript, signal) {
    const turnId = voiceTurnId(requestId)
    // The journal hashes what it is given: a transcript it cannot take whole is not sent at all, never sent in part.
    if (transcript.length > 4000) return { kind: 'refused', message: 'that was too long to journal as one spoken turn, so it was not sent' }
    let response
    try {
      response = await nativeFetch(VOICE_ROUTE, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'dispatch_turn', turnId, transcript }),
      })
    } catch {
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      return { kind: 'refused', message: 'the voice journal did not answer, so this spoken turn was not sent' }
    }
    // A host with no voice director at all (the Mac host): nothing to journal into.
    if (response.status === 404 || response.status === 501) return { kind: 'no-director' }
    const answer = await response.json().catch(() => null)
    if (response.ok && answer?.ok === true && answer.turnId === turnId && answer.voiceAuthority === 'none') return { kind: 'journaled', turnId }
    const code = typeof answer?.code === 'string' ? answer.code : `HTTP ${response.status}`
    return { kind: 'refused', message: `the voice journal refused this spoken turn (${code}), so it was not sent` }
  }

  /** Tell the edge a journaled spoken turn was cut (best effort: the page's own fence does the stopping). */
  function cancelSpokenTurn(turnId) {
    void nativeFetch(VOICE_ROUTE, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'barge_in', turnId }),
    }).catch(() => {})
  }

  /**
   * TAKE BACK A REQUEST WHOSE TURN HAD NOT STARTED. Removes it from her queue if it is still there; otherwise watches,
   * for a bounded time, for its turn to begin and cancels that turn as it does. Never cancels another party's turn: the
   * cancel is sent only once this request's own user message has opened a turn.
   */
  async function fenceRequest(sessionId, requestId) {
    const removeQueued = async () => {
      const state = await rpc('session/state', { request: { sessionId } }).catch(() => null)
      const queue = Array.isArray(state?.value?.queue) ? state.value.queue : Array.isArray(state?.queue) ? state.queue : []
      const item = queue.find(entry => entry?.rpcId === requestId)
      if (!item || typeof item.id !== 'string') return false
      await rpc('session/updateQueue', { request: { sessionId, itemId: item.id, action: { kind: 'remove' } } }).catch(() => {})
      return true
    }
    if (await removeQueued()) return 'removed'
    const watch = new AbortController()
    const timer = setTimeout(() => watch.abort(), FENCE_WATCH_MS)
    try {
      const carrier = await transport
      const follow = carrier.openStream('session/follow', {
        // (No assistantStream field: the gateway takes only `true` there, and the fence needs no assistant frames.)
        args: { request: { address: { kind: 'session', sessionId }, activate: false, maxMessages: 40 } },
      }, watch.signal)
      // A user message carries no turn number of its own: its turn is the one the latest turn/start opened (as streamTurn
      // reads it).
      let ownTurn = null
      let candidate = null
      const ended = new Set()
      const look = (event) => {
        const data = event?.data
        if (event?.type === 'turn/start') candidate = data?.turn ?? null
        if (event?.type === 'user/message' && data?.source?.rpcId === requestId) ownTurn = data?.turn ?? candidate ?? 'started'
        if (event?.type === 'turn/end' && data?.turn !== undefined) ended.add(data.turn)
      }
      for await (const frame of follow) {
        if (frame?.type === 'snapshot') {
          for (const record of Array.isArray(frame.records) ? frame.records : []) look(record?.event)
          // Started and already over: nothing left to stop. Started and running: stop it. Not started: try the queue again.
          if (ownTurn !== null) {
            if (!ended.has(ownTurn)) await rpc('session/cancel', { request: { sessionId } }).catch(() => {})
            return ended.has(ownTurn) ? 'finished-before-fence' : 'cancelled'
          }
          if (await removeQueued()) return 'removed'
          continue
        }
        if (frame?.type !== 'event') continue
        look(frame.event)
        if (ownTurn !== null) {
          await rpc('session/cancel', { request: { sessionId } }).catch(() => {})
          return 'cancelled'
        }
      }
      return 'not-seen'
    } catch {
      // At the end of the watch, one last look at the queue: a request still waiting there is taken out.
      if (await removeQueued().catch(() => false)) return 'removed'
      return watch.signal.aborted ? 'not-seen' : 'fence-failed'
    } finally {
      clearTimeout(timer)
      watch.abort()
    }
  }

  async function rpc(method, args, signal = new AbortController().signal) {
    const carrier = await transport
    const response = await carrier.fetch(`/api/${method}`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: mintId(), method, payload: { args } }),
    })
    const answer = await response.json()
    const result = answer.result ?? answer
    if (!response.ok || result?.ok === false) throw new Error(result?.error?.message ?? answer?.error?.message ?? `Genesis ${method} failed`)
    return result
  }

  async function listSessionItems() {
    // `payload.args` IS the argument record: `{ _request }` is `session/list`'s one parameter. The predecessor wrapped it in
    // a second `args`, which the gateway refuses as an unexpected field.
    const result = await rpc('session/list', { _request: {} })
    const items = Array.isArray(result.value?.items) ? result.value.items : []
    lastListed = items
    return items
  }

  /**
   * A NEW VOICE HOME: made with her preset and her home folder, and renamed to the voice title before any prompt can
   * reach it (the worker proves a home by exactly that). No fallback without the preset: such a home could never be
   * proven look-only, so it would carry no voice turn.
   */
  async function createVoiceHome() {
    if (creatingHome) return creatingHome
    if (freshHomeMade) throw new Error('Auma Live made its one fresh voice home on this page already')
    freshHomeMade = true
    const run = (async () => {
      const created = await rpc('session/create', {
        request: { cwd: AUMA_LIVE_VOICE_CWD, agentPreset: AUMA_LIVE_VOICE_PRESET },
      })
      const sessionId = text(created?.value?.sessionId ?? created?.sessionId)
      if (!sessionId) throw new Error('Genesis session/create returned no sessionId for Auma Live')
      await rpc('session/rename', { request: { sessionId, title: AUMA_LIVE_VOICE_TITLE } })
      writeStoredVoiceSession(sessionId)
      return sessionId
    })()
    creatingHome = run
    try {
      return await run
    } finally {
      if (creatingHome === run) creatingHome = null
    }
  }

  /**
   * Provision or reuse Auma Live's dedicated hidden Alien voice session (`/dsh/home/auma`, `auma-alien`).
   * Never touches `dsh.sessions.current`, so speaking in Auma Live never injects turns into an open chat thread.
   * Only a thread that already carries the voice title is adopted (stored or found): a working thread is never renamed
   * into the voice home, and a home the worker refused to prove is never adopted again. With nothing to adopt it makes a
   * home only while the page's one create is unspent; after that it fails, and the turn is refused in words.
   */
  async function ensureVoiceSession() {
    if (voiceSessionPromise) return voiceSessionPromise
    const run = (async () => {
      const items = await listSessionItems()
      const stored = readStoredVoiceSession()
      const storedItem = stored && !unprovenHomes.has(stored) ? items.find(item => item?.sessionId === stored) : undefined
      if (storedItem && isVoiceTitled(storedItem)) return stored
      const titled = items.find(item => isVoiceTitled(item) && typeof item.sessionId === 'string' && item.sessionId
        && !unprovenHomes.has(item.sessionId))
      if (titled) {
        writeStoredVoiceSession(titled.sessionId)
        return titled.sessionId
      }
      return createVoiceHome()
    })()
    voiceSessionPromise = run
    try {
      return await run
    } finally {
      if (voiceSessionPromise === run) voiceSessionPromise = null
    }
  }

  /**
   * Could a typed turn for this thread be meant for her voice home? Yes for a home the worker refused, the stored home, or
   * a thread listed with the voice title. Judged from what the page already knows; it lists once only for a thread it has
   * never seen, and it never makes a home. A list that fails counts as "could be" (the turn is then judged as the home's).
   */
  async function mayBeVoiceHome(sessionId) {
    if (unprovenHomes.has(sessionId)) return true
    const stored = readStoredVoiceSession()
    let item = lastListed.find(entry => entry?.sessionId === sessionId)
    if (!item && sessionId !== stored) {
      const items = await listSessionItems().catch(() => null)
      if (!items) return true
      item = items.find(entry => entry?.sessionId === sessionId)
    }
    return item ? isVoiceTitled(item) : sessionId === stored
  }

  async function minds() {
    const homeSession = await ensureVoiceSession().catch(() => '')
    return Response.json({
      minds: [], labels: {}, ...(homeSession ? { homeSession } : {}),
      providerSetup: {
        consentEnabled: false, recipient: PROVIDER, allowed: CLASSES,
        nativeSdkProviders: [],
      },
    }, { headers: { 'cache-control': 'no-store' } })
  }

  async function startVoice(body) {
    const requested = text(body.sessionId)
    const autoHome = body.autoHome === true || requested === AUMA_LIVE_AUTO_HOME
    if ((!requested && !autoHome) || body.recipient !== PROVIDER || JSON.stringify(body.classes) !== JSON.stringify(CLASSES)) {
      return Response.json({ refusal: 'invalid-voice-request' }, { status: 400 })
    }
    // A voice grant always names her voice home, whatever session was asked for: spoken words go nowhere else.
    const sessionId = await ensureVoiceSession().catch(() => '')
    if (!sessionId) return Response.json({ refusal: 'session-not-found' }, { status: 404 })
    const timestamp = now()
    for (const [token, grant] of grants) if (grant.expiresAt <= timestamp) grants.delete(token)
    if (grants.size >= MAX_GRANTS) return Response.json({ refusal: 'voice-session-limit' }, { status: 429 })
    const token = [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const grant = { voiceSessionToken: token, sessionId, recipient: PROVIDER, classes: CLASSES, expiresAt: timestamp + 3_600_000 }
    grants.set(token, grant)
    return Response.json(grant)
  }

  /** Ask the worker to hold this session look-only. Only `200 { ok: true, lookOnly: true }` is a yes. */
  async function markLookOnly(sessionId, signal) {
    let response
    let body = null
    try {
      const carrier = await transport
      response = await carrier.fetch(VOICE_MARK_PATH, {
        method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
      })
      body = await response.json().catch(() => null)
    } catch {
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      return { ok: false, unproven: false, say: VOICE_UNCONFIRMED_SAY }
    }
    const ok = response.status === 200 && body?.ok === true && body.lookOnly === true
    const code = typeof body?.code === 'string' ? body.code : ''
    const said = typeof body?.say === 'string' ? body.say.trim() : ''
    return {
      ok, unproven: response.status === 403 && code.startsWith('VOICE_HOME_UNPROVEN'),
      say: said && said.length <= 300 ? said : VOICE_UNCONFIRMED_SAY,
    }
  }

  /**
   * The voice home, confirmed look-only by the worker, with the roster of her other threads; or the sentence to say.
   * A home the worker cannot prove (403 VOICE_HOME_UNPROVEN) is replaced once by a fresh home and the mark is asked again
   * once; a second refusal is said and nothing is sent.
   */
  async function confirmLookOnly(home, signal) {
    let sessionId = home
    let answer = await markLookOnly(sessionId, signal)
    if (!answer.ok && answer.unproven) {
      unprovenHomes.add(sessionId)
      // The page's one fresh home is spent (made, or being made by a turn running beside this one, which this joins).
      if (freshHomeMade && !creatingHome) return { kind: 'refused', say: answer.say }
      try {
        sessionId = await untilAborted(createVoiceHome(), signal)
      } catch {
        if (signal.aborted) throw signal.reason ?? new Error('aborted')
        return { kind: 'refused', say: VOICE_UNCONFIRMED_SAY }
      }
      answer = await markLookOnly(sessionId, signal)
    }
    if (!answer.ok) return { kind: 'refused', say: answer.say }
    return { kind: 'ready', sessionId, roster: threadRoster(lastListed, { exclude: [sessionId, ...unprovenHomes], now: now() }) }
  }

  /** Resolve her voice home and confirm it look-only (Canvas speech, which names no voice home itself). */
  async function openLookOnly(signal) {
    let home
    try {
      home = await untilAborted(ensureVoiceSession(), signal)
    } catch {
      if (signal.aborted) throw signal.reason ?? new Error('aborted')
      return { kind: 'refused', say: VOICE_UNCONFIRMED_SAY }
    }
    return confirmLookOnly(home, signal)
  }

  /** Select a model and effort for ONE session through the worker's session-only route (it saves no default). */
  async function selectSessionModel(sessionId, provider, model, effort) {
    const controller = new AbortController()
    let timer
    const deadline = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(false) }, VOICE_MODEL_SELECT_MS) })
    const ask = (async () => {
      const carrier = await transport
      const response = await carrier.fetch(SESSION_MODEL_PATH, {
        method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, provider, model, ...(effort === null ? {} : { reasoningEffort: effort }) }),
      })
      const body = await response.json().catch(() => null)
      return response.status === 200 && body?.ok === true && body.savedDefault === false
    })().catch(() => false)
    try {
      return await Promise.race([ask, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * FASTER THINKING, VOICE THREAD ONLY. Once per voice home its effort goes to `low`, on the model it already uses (read
   * from the session, never typed in). The "deep" mind asks for the effort it had before (`null`: the model's own
   * default), and leaving "deep" asks for `low` again. One ask per change of what is wanted: a refusal or no answer
   * leaves the session as it is, is not asked again until the wish changes, and the turn goes on. Returns the selection
   * in effect, as far as this page knows it.
   */
  async function tuneVoiceMind(sessionId, current, deep) {
    let state = voiceMinds.get(sessionId)
    if (current && (!state || state.provider !== current.provider || state.model !== current.model)) {
      const effort = current.reasoningEffort ?? null
      state = { provider: current.provider, model: current.model, previous: effort === VOICE_EFFORT ? null : effort, applied: effort, asked: undefined }
      voiceMinds.set(sessionId, state)
    }
    // Nothing recorded yet (a home that has not thought once): left alone; a later turn asks.
    if (!state) return null
    const want = deep ? state.previous : VOICE_EFFORT
    const route = { provider: state.provider, model: state.model }
    if (state.applied !== want && state.asked !== want) {
      state.asked = want
      if (await selectSessionModel(sessionId, state.provider, state.model, want)) state.applied = want
    }
    return { ...route, ...(state.applied === null ? {} : { reasoningEffort: state.applied }) }
  }

  /**
   * One turn into one session, streamed back. A voice turn (`lookOnly` from presence, or any spoken turn) goes ONLY to the
   * voice home the worker confirmed look-only, with the roster of her other threads; a spoken turn the worker would not
   * confirm is not sent, and the sentence why is handed to `onToken` as what she says. `onMark` receives the timing marks
   * (journaled, accepted, started, and the tool rounds before her first text); nothing else in the stream depends on it.
   */
  async function streamTurn({ sessionId: requestedSession, text: ownerText, spoken = false, alienVoice = false, lookOnly = null, deep = false, signal, onToken, onState, onActivity, onFence, onMark }) {
    signal.throwIfAborted()
    let voice = lookOnly
    if (spoken && !voice) {
      // Canvas speech names the selected thread: spoken words go to her look-only voice home instead.
      const opened = await openLookOnly(signal)
      signal.throwIfAborted()
      if (opened.kind !== 'ready') {
        onToken?.(opened.say)
        return { reason: VOICE_LOOK_ONLY_REFUSED, text: opened.say, message: opened.say }
      }
      voice = opened
    }
    const sessionId = voice ? voice.sessionId : requestedSession
    const carrier = await transport
    const follow = carrier.openStream('session/follow', {
      args: {
        request: {
          address: { kind: 'session', sessionId }, activate: true, assistantStream: true, maxMessages: 40,
        },
      },
    }, signal)
    const iterator = follow[Symbol.asyncIterator]()
    const requestId = mintId()
    // From the moment the prompt may have been accepted until this request's turn has started, an abort takes it back.
    let promptSent = false
    let targetTurn = null
    let fenced = false
    let voiceTurnIdSent = null
    let selection = null
    const fence = () => {
      if (fenced || !promptSent || targetTurn !== null) return
      fenced = true
      void fenceRequest(sessionId, requestId).then(outcome => onFence?.(outcome), () => onFence?.('fence-failed'))
    }
    try {
      const opening = await iterator.next()
      signal.throwIfAborted()
      if (opening.done || opening.value?.type !== 'snapshot') throw new Error('Genesis session follow did not open a snapshot')
      if (voice) {
        selection = await tuneVoiceMind(sessionId, modelSelectionOf(opening.value), deep === true)
        signal.throwIfAborted()
      }
      let content = alienVoice
        ? [{ type: 'text', text: AUMA_LIVE_ALIEN_VOICE_DIRECTIVE }, { type: 'text', text: ownerText }]
        : [{ type: 'text', text: ownerText }]
      // Sight of her other threads rides every voice turn, after the provenance part (which stays first).
      if (voice) content = [{ type: 'text', text: voice.roster }, ...content]
      if (spoken) {
        const journal = await journalSpokenTurn(requestId, ownerText, signal)
        signal.throwIfAborted()
        if (journal.kind === 'refused') {
          await iterator.return?.().catch(() => {})
          return { reason: 'voice-journal-refused', text: '', message: journal.message }
        }
        if (journal.kind === 'journaled') {
          voiceTurnIdSent = journal.turnId
          onMark?.({ v: 'journaled' })
        }
        content = [{ type: 'text', text: journal.kind === 'journaled' ? VOICE_PROVENANCE : VOICE_PROVENANCE_UNJOURNALED }, ...content]
      }
      promptSent = true
      signal.addEventListener('abort', fence)
      // The prompt itself is never aborted from here: a request the host may already hold is taken back by the fence, not
      // abandoned mid-flight with no way to know whether it was accepted.
      await rpc('session/prompt', { request: { requestId, sessionId, mode: 'queue', content } })
      signal.throwIfAborted()
      onMark?.({ v: 'accepted', promptBytes: content.reduce((sum, part) => sum + utf8Bytes(part.text), 0) })
    } catch (error) {
      if (signal.aborted) fence()
      if (voiceTurnIdSent && signal.aborted) cancelSpokenTurn(voiceTurnIdSent)
      signal.removeEventListener('abort', fence)
      await iterator.return?.().catch(() => {})
      throw error
    }
    onState?.('sending')
    let candidateTurn = null
    let turnEnded = false
    let full = ''
    let liveTurn = null
    let liveStep = null
    const streamedSteps = new Set()
    // Timing marks only: the steps of this turn seen so far, to count her model rounds before her first text.
    const stepsOfTurn = new Set()
    // Where this request waits in her inbox, followed splice by splice (as the session client's own receipt does), so a
    // spoken prompt the worker takes out before its turn starts is said, not waited on.
    let queued = null
    let firstTextMarked = false
    const emit = (value, step) => {
      if (!value) return
      if (!firstTextMarked) {
        firstTextMarked = true
        const rounds = [...stepsOfTurn].filter(seen => seen !== String(step)).length
        onMark?.({ v: 'firstText', toolRounds: rounds })
      }
      full += value
      onToken?.(value)
    }
    // A cancel stops the session's ACTIVE turn. Until this prompt's own turn has started, the active turn (if any) is
    // someone else's work in her session (the composer's, a lane's), so an abort then cancels nothing.
    const cancel = () => {
      // A spoken turn that was cut is marked cancelled in the edge's journal too.
      if (voiceTurnIdSent) cancelSpokenTurn(voiceTurnIdSent)
      // Not started yet: the fence (registered above) takes the request back instead.
      if (targetTurn === null) return
      void rpc('session/cancel', { request: { sessionId } }, new AbortController().signal).catch(() => {})
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return { reason: 'stream-ended', text: full }
        // Every follow frame is proof the session is alive, so the page's idle timer does not abort a turn that is
        // queued behind another or running tools without text.
        onActivity?.()
        const frame = next.value
        if (frame?.type === 'event') {
          const event = frame.event
          const data = event?.data
          if (event?.type === 'agent/inbox/spliced' && targetTurn === null && Number.isSafeInteger(data?.start)) {
            const removedCount = Number.isSafeInteger(data.removedCount) ? data.removedCount : 0
            const inserted = Array.isArray(data.inserted) ? data.inserted : []
            if (queued !== null && queued.target === data.target) {
              const removed = queued.index >= data.start && queued.index < data.start + removedCount
              if (removed && data.outcome === 'canceled' && spoken) {
                // Taken out before its turn: nothing is left to fence, the journal entry is marked cut, and she says why.
                turnEnded = true
                if (voiceTurnIdSent) cancelSpokenTurn(voiceTurnIdSent)
                onToken?.(VOICE_TAKEN_BACK_SAY)
                return { reason: VOICE_LOOK_ONLY_REFUSED, text: VOICE_TAKEN_BACK_SAY, message: VOICE_TAKEN_BACK_SAY }
              }
              queued = removed ? null : { target: queued.target, index: queued.index < data.start ? queued.index : queued.index + inserted.length - removedCount }
            }
            inserted.forEach((message, index) => {
              if (message?.source?.rpcId === requestId) queued = { target: data.target, index: data.start + index }
            })
          }
          if (event?.type === 'turn/start') candidateTurn = data?.turn ?? null
          if (event?.type === 'user/message' && data?.source?.rpcId === requestId) {
            const firstMatch = targetTurn === null
            targetTurn = data?.turn ?? candidateTurn
            if (firstMatch) onMark?.({
              v: 'started',
              ...(typeof selection?.model === 'string' ? { model: selection.model } : {}),
              ...(typeof selection?.reasoningEffort === 'string' ? { effort: selection.reasoningEffort } : {}),
            })
            onState?.('responding')
          }
          if (event?.type === 'assistant/message' && targetTurn !== null && data?.turn === targetTurn) {
            const key = `${String(data.turn)}:${String(data.step)}`
            stepsOfTurn.add(String(data.step))
            if (!streamedSteps.has(key)) emit(turnText(data.message), data.step)
          }
          if (event?.type === 'turn/end' && targetTurn !== null && data?.turn === targetTurn) {
            turnEnded = true
            return {
              reason: typeof data?.reason?.kind === 'string' ? data.reason.kind : 'completed',
              text: full,
              ...(typeof data?.reason?.error?.message === 'string' ? { message: data.reason.error.message } : {}),
            }
          }
          continue
        }
        if (frame?.type !== 'assistant-stream') continue
        const live = frame.frame
        if (live?.type === 'start') {
          liveTurn = live.turn; liveStep = live.step
          if (targetTurn !== null && liveTurn === targetTurn) stepsOfTurn.add(String(liveStep))
          continue
        }
        if (live?.type === 'end') { liveTurn = null; liveStep = null; continue }
        if (live?.type !== 'chunk' || targetTurn === null || liveTurn !== targetTurn) continue
        const chunk = live.chunk
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string') continue
        streamedSteps.add(`${String(liveTurn)}:${String(liveStep)}`)
        stepsOfTurn.add(String(liveStep))
        onState?.('responding')
        emit(chunk.text, liveStep)
      }
    } finally {
      signal.removeEventListener('abort', cancel)
      // The stream ended or failed before this request's turn started: nobody will read its answer, so it is taken back.
      if (targetTurn === null && !signal.aborted && !turnEnded) fence()
      // An abort that lands after this point is not this request's to fence: it ended, or its turn started.
      if (!signal.aborted || targetTurn !== null) signal.removeEventListener('abort', fence)
      await iterator.return?.().catch(() => {})
    }
  }

  async function presence(init) {
    let body
    try { body = JSON.parse(init?.body ?? '{}') } catch { return new Response('invalid JSON', { status: 400 }) }
    if (body.action === 'stop-voice') {
      grants.delete(body.voiceSessionToken)
      return Response.json({ ok: true })
    }
    if (body.action === 'start-voice') return startVoice(body)
    const sessionId = text(body.sessionId)
    const ownerText = typeof body.text === 'string' ? body.text : ''
    if (!sessionId || !ownerText.trim() || ownerText.length > 32_768) return new Response('invalid presence request', { status: 400 })
    const suppliedToken = typeof body.voiceSessionToken === 'string' ? body.voiceSessionToken : ''
    const grant = grants.get(suppliedToken)
    if (suppliedToken && (!grant || grant.sessionId !== sessionId || grant.expiresAt <= now())) {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ t: 'done', reason: 'provider-consent-required' })}\n\n`))
          controller.close()
        },
      }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
    }
    const signal = init?.signal ?? new AbortController().signal
    const encoder = new TextEncoder()
    const spoken = body.spoken === true || Boolean(suppliedToken)
    const said = (frames, session) => new Response(new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        controller.close()
      },
    }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-auma-live-session': encodeURIComponent(session) } })
    const refuse = sentence => said([{ t: 'tok', v: sentence }, { t: 'done', reason: VOICE_LOOK_ONLY_REFUSED, message: sentence }], sessionId)
    // WHICH THREAD THIS TURN GOES TO, decided before anything is sent. A turn for her voice home (or for a home the worker
    // refused, which this page replaced) goes to the voice home the worker confirms look-only; a spoken turn for any other
    // thread is refused in words; a typed turn for another thread goes there unchanged.
    let target = sessionId
    let lookOnly = null
    try {
      // A typed turn for a thread that cannot be her voice home goes there unchanged: no home is resolved, made or waited
      // on for it (typed Canvas turns stay where they are).
      const typedElsewhere = !spoken && !(await untilAborted(mayBeVoiceHome(sessionId), signal))
      if (!typedElsewhere) {
        let home = ''
        try { home = await untilAborted(ensureVoiceSession(), signal) } catch { if (signal.aborted) throw signal.reason ?? new Error('aborted') }
        if (!home) return refuse(VOICE_UNCONFIRMED_SAY)
        if (sessionId === home || unprovenHomes.has(sessionId)) {
          const confirmed = await confirmLookOnly(home, signal)
          if (confirmed.kind !== 'ready') return refuse(confirmed.say)
          lookOnly = confirmed
          target = confirmed.sessionId
        } else if (spoken) {
          return refuse(VOICE_NOT_HOME_SAY)
        }
      }
    } catch {
      if (!signal.aborted) return refuse(VOICE_UNCONFIRMED_SAY)
      return said([{ t: 'done', reason: 'aborted' }], sessionId)
    }
    const headers = new Headers({
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      'x-auma-live-session': encodeURIComponent(target),
    })
    return new Response(new ReadableStream({
      start(controller) {
        let closed = false
        const send = value => {
          if (closed) return
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) } catch { closed = true }
        }
        const close = () => {
          if (closed) return
          closed = true
          try { controller.close() } catch { /* cancelled by reader */ }
        }
        // An abort is answered at once: the prompt itself is not aborted (the fence takes it back), so the turn's own end
        // could be a while coming.
        signal.addEventListener('abort', () => { send({ t: 'done', reason: 'aborted' }); close() }, { once: true })
        void streamTurn({
          sessionId: target, text: ownerText, signal, lookOnly,
          // Spoken (the page says so, and only Start Voice's own grant comes with a token): journaled as voice first.
          spoken,
          alienVoice: body.visual === true,
          // The mind picker's "deep" asks her voice thread for the effort it had before; every other choice keeps it quick.
          deep: body.mind === 'deep',
          onToken: value => send({ t: 'tok', v: value }),
          // Timing marks for the drawer's timing line; a page that does not know `t: 'mark'` ignores it.
          onMark: mark => send({ t: 'mark', ...mark }),
          // aumalive.js re-arms its idle timer on any `data:` frame and ignores a `t` it does not know.
          onActivity: () => send({ t: 'beat' }),
          // A request that could not be taken back is said, so nobody believes a stopped request is gone when it is not.
          onFence: outcome => { announceFence?.(outcome) },
        }).then(result => {
          send({ t: 'done', reason: result.reason, ...(typeof result.message === 'string' ? { message: result.message } : {}) })
        }).catch(error => {
          send({ t: 'done', reason: signal.aborted ? 'aborted' : 'stream-failed', message: error instanceof Error ? error.message : String(error) })
        }).finally(close)
      },
    }), { headers })
  }

  return {
    streamTurn,
    async fetch(input, init) {
      const url = new URL(input, globalThis.location?.origin ?? 'http://localhost')
      if (url.pathname === MINDS_PATH && (!init?.method || init.method === 'GET')) return minds()
      if (url.pathname === PRESENCE_PATH && init?.method === 'POST') return presence(init)
      return nativeFetch(input, init)
    },
  }
}

let defaultLive
let fenceListener = null
export function genesisLiveFetch(nativeFetch, announceFence) {
  if (!defaultLive) defaultLive = createGenesisLive({ transport: defaultTransport(), nativeFetch, announceFence: outcome => fenceListener?.(outcome) })
  if (announceFence) fenceListener = announceFence
  return Object.assign(defaultLive.fetch, { streamTurn: defaultLive.streamTurn })
}

export { PROVIDER as GENESIS_PROVIDER, CLASSES as GENESIS_VOICE_CLASSES }
