// ONE MANAGED VOICE SESSION.
//
// Ported from the website's session controller (AUKORA.xyz exact/voice/managed-conversation.mjs): the same states, the
// same generation counter, the same deadlines and the same 50 ms meter. What is different is who writes her words. The
// provider hears the owner and speaks; the edge journals each heard turn and hands it to this page over the TAB DOOR;
// this page runs her governed voice turn for it (`runTurn`) and streams HER text back up the same door. No local VAD,
// recorder, recogniser, speech chunker or player: the provider owns capture, turn-taking, interruption and playback.
//
// Everything outside is injected (the SDK's startSession, the fetch, the socket, the governed turn, the timers), so the
// whole controller runs in tests with fakes. Only browser.mjs imports the SDK.
import {
  AWARE_EVERY_MS, AWARE_STUCK_MS, SPOKEN_CHARS, BRIDGE_PATH, CALL_END_REASONS, CONVERSATION_ID_RE, FAIL_CODE_RE, FAIL_CODES, FAST_TOOLS, HANDED_NAMED_LINE, LINES, MANAGED_SESSION_BODY,
  MANAGED_VOICE, NOT_SIGN_IN_CODES, OFF_CODES, OPEN_DROP_MS, OFF_STATUSES, REFUSAL_LINES, SDK_DISCONNECT_REASONS, SDK_WATCH_MS, SIGN_IN_STATUSES, SILENT_OPENING,
  TOOL_CALL_RE, TURN_ID_RE, VOICE_ROUTE, WORKLET_PATH, classifySdkError,
} from './policy.mjs'

const utf8 = value => new TextEncoder().encode(value).byteLength
const HEX_64 = /^[0-9a-f]{64}$/
/** The `seq` and `digest` an answer carries, or null when it carries none. */
const headFields = answer => (answer && typeof answer === 'object' && Number.isSafeInteger(answer.seq) && answer.seq >= 0
  && typeof answer.digest === 'string' && HEX_64.test(answer.digest) ? { seq: answer.seq, digest: answer.digest } : null)
/**
 * Her home's head, only from an answer that READ it (`ok: true`). A refusal like HOME_UNREADABLE carries seq 0 and 64
 * zeros, which the frames reserve for "her home has no chain": an unreadable home is never told to the edge as an empty
 * one (review frames 1). A GAP or FORK refusal comes with the head her home read before refusing.
 */
const memoryHead = answer => (answer?.ok === true ? headFields(answer) : null)
const refusedHead = answer => (answer?.ok === false && (answer.code === 'GAP' || answer.code === 'FORK') ? headFields(answer) : null)
/** The longest conversation title a handed turn may name (voice-fast.mjs HAND_OFF_TITLE_CHARS). */
const HANDED_TITLE_CHARS = 80
const clampLevel = value => (Number.isFinite(value) && value > 0 ? Math.min(1, value * 3) : 0)
const validSeconds = value => Number.isInteger(value) && value >= MANAGED_VOICE.minSeconds && value <= MANAGED_VOICE.maxSeconds
const validCallPass = value => typeof value === 'string' && value.length >= 40 && value.length <= 16_384 && !/\s/.test(value)
const codeOf = body => {
  const code = typeof body?.code === 'string' ? body.code : typeof body?.error?.code === 'string' ? body.error.code : ''
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : ''
}

/** Her text cut into pieces that each fit one `delta` frame (code points, never a split surrogate pair). */
export function deltaPieces(text) {
  const points = Array.from(String(text ?? ''))
  const pieces = []
  for (let at = 0; at < points.length; at += MANAGED_VOICE.deltaCodePoints) {
    pieces.push(points.slice(at, at + MANAGED_VOICE.deltaCodePoints).join(''))
  }
  return pieces
}

/** The page note her worker ends a paged `look` answer with (ball-loader.ts voiceToolPage). */
const PAGE_NOTE_RE = /\n\[bytes (\d+) to (\d+) of (\d+); (?:call again with from:\d+ for more|that is the end)\]$/

/**
 * One tool result as its `tool_result` frame: the text cut to FAST_TOOLS.toolResultBytes IN ALL, its plain
 * note included ("cut at N bytes of M": room is kept for it, so the edge's own bound never cuts it again), and cut
 * further when its escaped frame would not fit the tab door. A paged answer (its worker note says which bytes it is)
 * that must be cut keeps a page note, moved to where it now ends, so the next page is still asked from the right byte.
 */
export function toolResultFrame(turn, call, ok, text, frameBytes = MANAGED_VOICE.frameBytes) {
  const whole = String(text ?? '')
  const paged = PAGE_NOTE_RE.exec(whole)
  const all = new TextEncoder().encode(paged ? whole.slice(0, paged.index) : whole)
  const fits = utf8(whole) <= FAST_TOOLS.toolResultBytes
  let keep = fits ? all.byteLength : Math.min(all.byteLength, FAST_TOOLS.toolResultBytes - FAST_TOOLS.noteBytes)
  for (;;) {
    let end = keep
    while (end > 0 && end < all.byteLength && (all[end] & 0xc0) === 0x80) end--
    const body = new TextDecoder().decode(all.subarray(0, end))
    const cut = end < all.byteLength
    const value = paged
      ? (cut ? `${body}\n[bytes ${paged[1]} to ${String(Number(paged[1]) + end)} of ${paged[3]}; call again with from:${String(Number(paged[1]) + end)} for more]` : whole)
      : cut ? `${body}\n[cut at ${String(end)} bytes of ${String(all.byteLength)}]` : body
    const frame = { t: 'tool_result', turn, call, ok: ok === true, text: value }
    const size = utf8(JSON.stringify(frame))
    if (size <= frameBytes || end === 0) return frame
    keep = Math.max(0, end - (size - frameBytes) - 64)
  }
}

/**
 * What the edge's answer to `managed_session` means: a call, or the orb rests with ONE line and no other voice starts
 * (the managed voice is the voice; there is no fallback to an older voice). The line:
 * the switch off or no such door (`off`): "not set up"; a refusal from the edge's closed list: its own line; a 401/403
 * (an owner signed in without his fingerprint session on this browser): LINES.signIn; anything else that is not a valid
 * call (a 5xx, a bad body): LINES.unreachable.
 */
export function readSessionAnswer(status, body) {
  const code = codeOf(body)
  if (OFF_STATUSES.includes(status) || OFF_CODES.includes(code)) return { kind: 'off', line: REFUSAL_LINES.VOICE_NOT_CONFIGURED }
  if (Object.hasOwn(REFUSAL_LINES, code)) return { kind: 'refused', code, line: REFUSAL_LINES[code] }
  if (SIGN_IN_STATUSES.includes(status) && !NOT_SIGN_IN_CODES.includes(code)) {
    return { kind: 'refused', code: code || 'VOICE_SIGN_IN_REQUIRED', line: LINES.signIn }
  }
  if (status !== 200 || body?.ok === false || !validCallPass(body?.token) || !validSeconds(body?.maxDurationSeconds)) {
    return { kind: 'refused', code: code || 'VOICE_ANSWER_INVALID', line: LINES.unreachable }
  }
  return { kind: 'call', pass: body.token, seconds: body.maxDurationSeconds }
}

/** Words a provider uses when it refuses the first-message override (the agent's config does not allow it). */
const OVERRIDE_REFUSED_RE = /override|first[_ ]?message/i
const detailText = value => {
  if (!value) return ''
  if (typeof value === 'string') return value
  return [value.message, value.closeReason, value.reason, value.context?.reason].filter(part => typeof part === 'string').join(' ')
}

/**
 * @param {object} deps
 * @param {(config: object) => Promise<object>} deps.startSession  the SDK's Conversation.startSession
 * @param {(path: string, init: object) => Promise<Response>} deps.request  same-origin fetch
 * @param {(path: string) => WebSocket} deps.openBridge  opens the same-origin tab door
 * @param {(turn: { turnId: string, transcript: string, council: boolean, signal: AbortSignal, say: (text: string) => void, carry: () => void }) => Promise<{ ok: true } | { ok: false, code: string }>} deps.runTurn
 *   `carry()` (called by her turn at voice level open): when the CALL ends by anything but the owner's Stop (the edge's
 *   end, the provider hanging up, the tab door dropping, the call's own deadline), this turn is let go, not cut: her work
 *   goes on in her thread and her answer lands there and in the transcript; nothing more goes up the tab door for it.
 *   The edge's `cancel` and the owner's Stop still cut it at once; the provider's interruption cuts nothing on the page
 *   (only the edge decides an interruption).
 * @param {(press: { signal: AbortSignal }) => Promise<string>} [deps.arrival]  her first words (governed-turn.mjs
 *   createArrivalRunner): started once the edge answers with a call, waited for at most MANAGED_VOICE.arrivalMs.
 *   Without it, or when she writes nothing in time, the call opens silent.
 * @param {(facts: { opened: string }, hooks: { onLater: () => void }) => Promise<object|null>} [deps.awareness]  the fast voice:
 *   her page's awareness frame (genesis-live.js voiceAwareness, given her first words of this call), sent up the tab door
 *   when it is ready, after each of her turns, every AWARE_EVERY_MS, and at once when `onLater` is called
 *   (her slow reads settled with something new).
 * @param {(exchange: { heard: string, said: string }) => void} [deps.onSpoken]  the fast voice: one exchange her fast voice
 *   had at the edge (genesis-live.js noteSpoken: it rides her next governed prompt in the voice thread).
 * @param {(call: { name: string, args: string, signal: AbortSignal }) => Promise<{ ok: boolean, text: string }>} [deps.tools]
 *   the voice tools: runs one of her fast voice's tool calls with her own tools under her worker's look-only check
 *   (genesis-live.js voiceTool). Without it every call is answered that this page cannot run tools.
 * @param {(turn: { turnId: string, transcript: string, conversation: string, signal: AbortSignal }) => Promise<{ ok: boolean }>} [deps.handOff]
 *   the voice tools V5: a handed turn that names one of her conversations (`conversation`, its awareness title) is queued
 *   there (genesis-live.js handOffTo); when that is not possible, the turn runs in her voice thread as before.
 * @param {() => number} [deps.now]  the voice tools part 2: the clock for `status.sdk.lastErrorSeconds` (ms).
 * @param {(body: { action: 'head' } | { action: 'append', items: object[] }) => Promise<object|null>} [deps.memory]
 *   the voice memory: her worker's `/__x6__/voice-memory` route (genesis-live.js voiceMemory). After `ready` her home's head
 *   goes to the bridge as `memory_have`; each `memory` frame is one append, answered `memory_ack` or `memory_nack`.
 */
export function createManagedConversation({
  startSession, request, openBridge, runTurn, arrival = null, awareness = null, onSpoken = () => {}, tools = null, handOff = null,
  onState = () => {}, onTranscript = () => {}, onCorrection = () => {}, onLevels = () => {}, onNotice = () => {},
  timers = globalThis, muted: initiallyMuted = false, now = () => Date.now(), memory = null,
}) {
  let session = null, generation = 0, state = 'idle', pending = null, meter = null
  /** The arrival turn of this press, cut on Stop, on any answer that is not a call, and at its deadline. */
  let arriving = null
  let connectTimer = null, durationTimer = null, connected = false
  /** The awareness push of this call (its interval, and whether one is being gathered now), and her first
   * words of this call ('' when it opened silent or with the provider's own words): the fast voice is told them. */
  let awareTimer = null, openedWith = ''
  /** When the push in flight began (null: none), the number of the last push begun and of the last one
   * sent (a late answer never follows a newer frame), and whether a push was asked for while one was in flight. */
  let awareSince = null, awarePushNo = 0, awareSentNo = 0, awareAgain = false
  // The page's mute state at the moment the controller is made (the owner may have muted before his first press).
  let muted = Boolean(initiallyMuted), typedId = 0
  // Each SDK session this press opens; a retry without the first-message override is a second attempt.
  let attemptNo = 0, retrying = null
  /**
   * DROPPED AS IT OPENED (2026-11-18). A call that carried her first words (the first-message override) and ended before
   * the provider showed any life is read as the provider refusing the override without saying so (over WebRTC its words
   * do not reach the page; the SDK only reports the end). From then on, until the page is reloaded, a press asks for no
   * first words and sends no override: the provider's own setting opens the call. Never set back within a page's life.
   */
  let openPlain = false
  /** Marks the current attempt as having seen provider life, for the edge's frames that prove the provider reached it
   *  (`turn`, `spoken`); set by call(), cleared by stop(). It does not touch the SDK watch (see `receive`). */
  let attemptLived = null
  let bridge = null, bridgeReady = false, conversation = ''
  const seen = new Set()
  /** Her turns open now, by the edge's turn id. */
  const turns = new Map()
  /** Her turns that outlived their call (`carry`): still running in her thread, cut only by the owner's Stop. */
  const carried = new Set()
  /** Every turn id this call has run: one governed turn per id, whatever the edge sends twice. */
  const handled = new Set()
  /** Her fast voice's tool calls running now, by `<turn> <call>`, each with its controller. */
  const toolCalls = new Map()
  const toolsSeen = new Set()
  /**
   * the voice tools part 2: what the SDK reported this press, in closed fields only (never its words): how many `onError`s,
   * the last one's whole seconds since the press, its closed kind (policy.mjs SDK_ERROR_KINDS), and the closed reason
   * and close code of its `onDisconnect`. Exposed as `status.sdk` (no page reads it yet); only the kind leaves the page,
   * on the call's `bye` as `sdk`.
   */
  let sdk = null, pressedAt = 0, sdkWatch = null
  const freshSdk = () => ({ errors: 0, lastErrorSeconds: null, kind: null, disconnectReason: null, disconnectCode: null })
  sdk = freshSdk()
  function clearSdkWatch() { timers.clearTimeout(sdkWatch); sdkWatch = null }
  /** A sign of life from the provider or the bridge: the call is not dead, whatever the SDK reported before. */
  function alive() { if (sdkWatch !== null) clearSdkWatch() }
  const clockNow = () => { try { const at = Number(now()); return Number.isFinite(at) ? at : 0 } catch { return 0 } }

  const change = next => { if (state !== next) { state = next; onState(next) } }
  const current = id => id === generation
  const end = value => { if (value) { try { void Promise.resolve(value.endSession()).catch(() => {}) } catch { /* already ended */ } } }
  const thinking = () => [...turns.values()].some(turn => !turn.spoke && !turn.controller.signal.aborted)

  function stopTimers() {
    timers.clearInterval(meter); timers.clearTimeout(connectTimer); timers.clearTimeout(durationTimer)
    meter = connectTimer = durationTimer = null
    clearSdkWatch()
    onLevels(0, 0, false)
  }

  /**
   * The memory frames run one after another (her home appends in order), never in a turn's way: nothing
   * awaits this queue but itself. A failed write is answered once (`WRITE_FAILED`, with her home's head read again) and
   * tried again only when the bridge sends the next frame, never in a loop.
   */
  let memoryQueue = Promise.resolve()
  /**
   * Whether this call's `memory_have` went up (the edge sends memory frames only after it), and whether a head read for
   * it is in flight. A read that failed (or found her home unreadable) is tried again with the next awareness push and
   * after each of her turns, until one is sent (review frames 2); never in a loop of its own.
   */
  let haveSent = false, haveAsking = false
  async function memoryHave(id) {
    if (typeof memory !== 'function' || haveSent || haveAsking || !current(id) || !bridgeReady) return
    haveAsking = true
    let head = null
    try { head = memoryHead(await memory({ action: 'head' })) } catch { head = null } finally { haveAsking = false }
    if (head && current(id) && bridgeReady && !haveSent && send({ t: 'memory_have', seq: head.seq, digest: head.digest })) haveSent = true
  }
  function memoryFrame(frame, id) {
    if (typeof memory !== 'function') return
    const items = frame.items
    if (!Array.isArray(items) || items.length === 0 || items.length > MANAGED_VOICE.memoryItems
      || !items.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) return
    memoryQueue = memoryQueue.then(async () => {
      let answer = null
      try { answer = await memory({ action: 'append', items }) } catch { answer = null }
      if (!current(id) || !bridgeReady) return
      const head = memoryHead(answer)
      if (head) { send({ t: 'memory_ack', seq: head.seq, digest: head.digest }); return }
      // A nack carries a head her home READ; with none (an unreadable home) nothing is sent and the edge changes nothing.
      let home = refusedHead(answer)
      if (!home) { try { home = memoryHead(await memory({ action: 'head' })) } catch { home = null } }
      if (!home || !current(id) || !bridgeReady) return
      const code = answer?.code === 'GAP' || answer?.code === 'FORK' ? answer.code : 'WRITE_FAILED'
      send({ t: 'memory_nack', code, seq: home.seq, digest: home.digest })
    }).catch(() => {})
  }

  function send(frame) {
    const socket = bridge
    if (!socket || socket.readyState !== 1) return false
    const text = JSON.stringify(frame)
    if (utf8(text) > (frame?.t === 'aware' ? MANAGED_VOICE.awareBytes : MANAGED_VOICE.frameBytes)) return false
    try { socket.send(text); return true } catch { return false }
  }

  /**
   * `why` the page ends the call, for the edge's call history (voice-bridge-do.mjs BYE_ENDS): 'stop' (the owner's Stop),
   * 'timer' (the call's own duration ran out here), 'disconnected' (the provider hung up), 'error' (anything else).
   */
  function closeBridge(why) {
    const socket = bridge
    bridge = null; bridgeReady = false
    for (const running of toolCalls.values()) running.abort()
    toolCalls.clear(); toolsSeen.clear()
    timers.clearInterval(awareTimer); awareTimer = null
    if (!socket) return
    // The closed kind of the SDK's last error this press, when it reported one (voice-bridge-do.mjs parseTabFrame).
    const bye = sdk.kind ? { t: 'bye', why, sdk: sdk.kind } : { t: 'bye', why }
    try { if (socket.readyState === 1) socket.send(JSON.stringify(bye)) } catch { /* closing anyway */ }
    socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null
    try { socket.close() } catch { /* already closed */ }
  }

  /** A turn let go when its call ended: it keeps running in her thread; the tab door hears nothing more of it. */
  function release(turnId, turn) {
    if (turns.get(turnId) === turn) turns.delete(turnId)
    turn.released = true
    carried.add(turn)
  }

  /**
   * Stop: a new generation, every request and timer cleared, the tab door closed, the call ended. The owner's Stop
   * (`callOnly` false) cuts every turn, those carried past an earlier call too. The call ending by itself (`callOnly`
   * true) cuts every turn except those that asked to be carried.
   */
  function stop(callOnly = false, why = callOnly ? 'error' : 'stop') {
    generation++
    attemptLived = null
    pending?.abort(); pending = null
    arriving?.abort(); arriving = null
    for (const [turnId, turn] of turns) {
      if (callOnly && turn.carry && !turn.controller.signal.aborted) release(turnId, turn)
      else { turn.by = 'stopped'; turn.controller.abort() }
    }
    if (!callOnly) {
      for (const turn of carried) { turn.by = 'stopped'; turn.controller.abort() }
      carried.clear()
    }
    turns.clear()
    closeBridge(why)
    connected = false; conversation = ''
    const old = session; session = null
    stopTimers()
    change('idle')
    end(old)
  }
  /** The call ended (not by the owner's Stop): one line, and her carried turns go on. */
  function fail(line, why = 'error') { stop(true, why); onNotice(line) }

  /** Her words for one turn, up the tab door in order, `seq` rising by one from 0. */
  function delta(turnId, text, id) {
    const turn = turns.get(turnId)
    if (!current(id) || !turn || turn.controller.signal.aborted) return
    for (const piece of deltaPieces(text)) {
      if (!piece) continue
      turn.spoke = true
      send({ t: 'delta', turn: turnId, seq: turn.seq++, text: piece })
    }
  }

  /**
   * Her page's awareness, gathered and sent up the tab door (a failure sends nothing). One at a
   * time, but a push in flight for more than AWARE_STUCK_MS no longer blocks the next; an answer older than a frame
   * already sent is dropped; a push asked for while one is in flight runs once it ends.
   */
  async function pushAwareness(id) {
    // the voice memory frames 2: this call's memory_have, when the read at `ready` did not send one.
    if (!haveSent) void memoryHave(id)
    if (typeof awareness !== 'function' || !current(id) || !bridgeReady) return
    if (awareSince !== null && clockNow() - awareSince < AWARE_STUCK_MS) { awareAgain = true; return }
    const mine = ++awarePushNo
    awareSince = clockNow()
    awareAgain = false
    try {
      const frame = await awareness({ opened: openedWith }, { onLater: () => { void pushAwareness(id) } })
      if (mine > awareSentNo && current(id) && bridgeReady && frame && typeof frame === 'object' && frame.t === 'aware' && send(frame)) awareSentNo = mine
    } catch { /* nothing sent; the next push tries again */ } finally {
      if (mine === awarePushNo) {
        awareSince = null
        if (awareAgain) { awareAgain = false; void pushAwareness(id) }
      }
    }
  }

  /** Turns carried past an earlier call are cut (his new turn into her voice thread would wait behind them). */
  function cutCarried() {
    for (const turn of carried) { turn.by = 'interrupted'; turn.controller.abort() }
    carried.clear()
  }

  async function runOne(turnId, transcript, id, named = '', council = false) {
    const turn = { controller: new AbortController(), seq: 0, spoke: false, by: '', carry: false, released: false }
    turns.set(turnId, turn)
    handled.add(turnId)
    if (state === 'listening') change('thinking')
    let outcome
    try {
      // the voice tools V5: queued in the conversation he named, or (when that cannot be done) her voice thread, as before.
      const handed = named && typeof handOff === 'function'
        ? await handOff({ turnId, transcript, conversation: named, signal: turn.controller.signal }).catch(() => null) : null
      if (handed?.ok === true) {
        outcome = { ok: true }
        // A hand-off by name has no words of its own from her governed session here: one short line says it was queued.
        if (!turn.spoke) delta(turnId, HANDED_NAMED_LINE, id)
      } else {
        // Into her voice thread after all: turns carried past an earlier call would hold it up (see `receive`).
        if (named) cutCarried()
        outcome = await runTurn({
          turnId, transcript, council, signal: turn.controller.signal, say: text => delta(turnId, text, id),
          carry: () => { turn.carry = true },
        })
      }
    } catch {
      outcome = { ok: false, code: FAIL_CODES.failed }
    } finally {
      if (turns.get(turnId) === turn) turns.delete(turnId)
      carried.delete(turn)
      // Her turn may have changed what her page knows: the fast voice hears it now.
      void pushAwareness(id)
    }
    // Carried past its call: her answer is in her thread and the transcript; the edge has closed this turn already.
    if (turn.released || !current(id)) return
    if (turn.controller.signal.aborted) {
      // Cut by his next turn (a carried turn: `cutCarried`): the edge is told. Cut by the edge itself, or by Stop:
      // nothing more to say. (The provider's interruption cuts nothing here since the voice fix.)
      if (turn.by === 'interrupted') send({ t: 'fail', turn: turnId, code: FAIL_CODES.cancelled })
      return
    }
    // A turn that said anything (her words, or the page's own sentence for it: a look-only refusal, a quiet or failed
    // turn) ends with `done`, so the edge speaks what it holds; `fail` is for a turn with nothing to say.
    if (outcome?.ok === true || turn.spoke) send({ t: 'done', turn: turnId })
    else send({ t: 'fail', turn: turnId, code: typeof outcome?.code === 'string' && FAIL_CODE_RE.test(outcome.code) ? outcome.code : FAIL_CODES.failed })
  }

  /** One tool call from the bridge, run here and answered once (never after a cancel, a Stop or a new call). */
  async function runTool(frame, id) {
    const key = `${frame.turn} ${frame.call}`
    if (toolsSeen.has(key)) return
    toolsSeen.add(key)
    if (toolCalls.size >= FAST_TOOLS.openCalls) { send(toolResultFrame(frame.turn, frame.call, false, 'Not run: too many of my tools are running at once.')); return }
    const controller = new AbortController()
    toolCalls.set(key, controller)
    const timer = timers.setTimeout(() => controller.abort(), FAST_TOOLS.toolMs)
    let answer
    try {
      answer = typeof tools === 'function'
        ? await tools({ name: frame.name, args: frame.args, signal: controller.signal })
        : { ok: false, text: 'This page cannot run my tools.' }
    } catch {
      answer = { ok: false, text: controller.signal.aborted ? 'The tool did not answer in time.' : 'The tool failed in my page.' }
    } finally {
      timers.clearTimeout(timer)
    }
    if (toolCalls.get(key) !== controller) return
    toolCalls.delete(key)
    if (!current(id) || (controller.signal.aborted && answer?.ok !== true && !answer?.text)) return
    send(toolResultFrame(frame.turn, frame.call, answer?.ok === true, typeof answer?.text === 'string' ? answer.text : ''))
  }

  function receive(data, id) {
    if (typeof data !== 'string') return
    // A `memory` frame may be up to memoryFrameBytes; every other frame keeps the tab door's bound.
    const size = utf8(data)
    if (size > MANAGED_VOICE.memoryFrameBytes) return
    let frame
    try { frame = JSON.parse(data) } catch { return }
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return
    if (frame.t !== 'memory' && size > MANAGED_VOICE.frameBytes) return
    if (frame.t === 'ready') {
      if (frame.conv !== conversation) { fail(LINES.link); return }
      bridgeReady = true
      timers.clearTimeout(connectTimer); connectTimer = null
      haveSent = false; haveAsking = false
      void memoryHave(id)
      if (typeof awareness === 'function') {
        void pushAwareness(id)
        timers.clearInterval(awareTimer)
        awareTimer = timers.setInterval(() => { void pushAwareness(id) }, AWARE_EVERY_MS)
      }
      return
    }
    if (!bridgeReady) return
    if (frame.t === 'end') { fail(LINES.ended); return }
    if (frame.t === 'memory') { memoryFrame(frame, id); return }
    // the voice tools part 2: only a bridge frame that follows a fresh provider transcript is a sign of life (`turn` below,
    // and a cancel of the turn it superseded). `spoken`, `tool`, `tool_cancel` and the call-end cancels come from the
    // edge's own fast voice and timers, not from the provider.
    if (frame.t === 'cancel' && frame.reason === 'superseded') alive()
    if (frame.t === 'cancel') {
      const turn = typeof frame.turn === 'string' ? turns.get(frame.turn) : undefined
      // The edge ended the CALL (its `end` follows): a carried turn is let go, not cut. Anything else cuts it.
      if (turn && !turn.controller.signal.aborted && turn.carry && CALL_END_REASONS.includes(frame.reason)) release(frame.turn, turn)
      else if (turn && !turn.controller.signal.aborted) { turn.by = 'edge'; turn.controller.abort() }
      // A turn the edge heard but could not record: it never ran and nothing was said. The owner is told, once.
      if (!turn && frame.reason === 'unjournaled' && typeof frame.turn === 'string' && TURN_ID_RE.test(frame.turn) && !handled.has(frame.turn)) {
        handled.add(frame.turn)
        onNotice(LINES.unjournaled)
      }
      return
    }
    if (frame.t === 'tool') {
      // Her fast voice asks one of her tools; the bridge named the call and bounded it; checked again here.
      const ok = typeof frame.turn === 'string' && TURN_ID_RE.test(frame.turn) && typeof frame.call === 'string' && TOOL_CALL_RE.test(frame.call)
        && typeof frame.name === 'string' && frame.name.length > 0 && frame.name.length <= FAST_TOOLS.nameChars
        && typeof frame.args === 'string' && utf8(frame.args) <= FAST_TOOLS.argsBytes
      if (ok) void runTool(frame, id)
      return
    }
    if (frame.t === 'tool_cancel') {
      // The turn was cut: its calls stop, and nothing is answered for them.
      if (typeof frame.turn !== 'string') return
      for (const [key, running] of toolCalls) if (key.startsWith(`${frame.turn} `)) { toolCalls.delete(key); running.abort() }
      return
    }
    if (frame.t === 'spoken') {
      // Her fast voice answered at the edge: her line in the transcript, and the exchange kept for her next prompt.
      const heard = typeof frame.heard === 'string' ? frame.heard.trim().slice(0, SPOKEN_CHARS.heard) : ''
      const said = typeof frame.said === 'string' ? frame.said.trim().slice(0, SPOKEN_CHARS.said) : ''
      if (typeof frame.turn !== 'string' || !TURN_ID_RE.test(frame.turn) || !heard || !said) return
      // The provider heard him and reached the edge: life for "dropped as it opened" (not for the SDK watch, as before).
      attemptLived?.()
      onTranscript('auma', said, `fast:${frame.turn}`)
      try { onSpoken({ heard, said }) } catch { /* the page keeps its own state */ }
      return
    }
    if (frame.t !== 'turn') return
    const turnId = typeof frame.turn === 'string' && TURN_ID_RE.test(frame.turn) ? frame.turn : ''
    if (!turnId || handled.has(turnId)) return
    alive()
    attemptLived?.()
    const transcript = typeof frame.transcript === 'string' ? frame.transcript.trim() : ''
    if (!transcript || transcript.length > MANAGED_VOICE.transcriptChars) {
      handled.add(turnId)
      send({ t: 'fail', turn: turnId, code: FAIL_CODES.invalid })
      return
    }
    // He asks something new while turns carried past an earlier call still run: her session takes prompts in queue
    // mode, so his new turn would wait silently behind them. The new turn is his interruption: they are cut at once.
    // Not for a hand-off that names another conversation (V5: it never interrupts; nothing of it runs in her voice
    // thread); if that hand-off cannot be done, they are cut when it falls back to her voice thread (runOne).
    const named = typeof frame.conversation === 'string' && frame.conversation.length <= HANDED_TITLE_CHARS ? frame.conversation : ''
    if (!named) cutCarried()
    if (turns.size >= MANAGED_VOICE.maxOpenTurns) {
      handled.add(turnId)
      send({ t: 'fail', turn: turnId, code: FAIL_CODES.busy })
      return
    }
    // The edge's closed marker that his own words asked for the council (voice-fast.mjs councilAsked);
    // anything else is no marker.
    void runOne(turnId, transcript, id, named, frame.kind === 'council')
  }

  /** The tab door opens once the call is connected and the SDK has named its conversation. */
  function openTabDoor(id) {
    if (!current(id) || !connected || !session || bridge) return
    let conv = ''
    try { conv = String(session.getId?.() ?? '') } catch { conv = '' }
    if (!CONVERSATION_ID_RE.test(conv)) { fail(LINES.link); return }
    let socket
    try { socket = openBridge(BRIDGE_PATH) } catch { fail(LINES.link); return }
    conversation = conv
    bridge = socket
    socket.onopen = () => { if (bridge === socket && current(id)) send({ t: 'hello', conv }) }
    socket.onmessage = event => { if (bridge === socket && current(id)) receive(event?.data, id) }
    socket.onerror = () => { /* onclose decides */ }
    socket.onclose = () => { if (bridge === socket && current(id)) { bridge = null; fail(LINES.link) } }
  }

  /**
   * One press of the orb. Resolves to what happened: `started` (a call is up), `off` (no managed voice here: the orb
   * rests with the "not set up" line), `refused` (the orb rests with one line said), `stopped` (Stop came first) or
   * `busy`. Whatever it resolves to, no other voice starts.
   */
  /**
   * Her arrival turn for this press, started only once the edge has answered with a call: a press the edge answers off
   * or refused (or that Stop ends first) finds no home, makes no thread and sends her no prompt.
   */
  function beginArrival() {
    if (typeof arrival !== 'function') return null
    const controller = new AbortController()
    arriving = controller
    const words = Promise.resolve().then(() => arrival({ signal: controller.signal }))
      .then(value => (typeof value === 'string' ? value.trim() : SILENT_OPENING), () => SILENT_OPENING)
    return { controller, words }
  }

  /**
   * The call's first words: what she wrote, once her arrival turn ends, or at most MANAGED_VOICE.arrivalMs after the
   * edge's answer. At the deadline her turn is cut; the runner answers a cut with the sentences she had finished, and is
   * given a quarter second for it. No arrival, nothing written, or nothing in time: the call opens silent.
   */
  async function firstWords(run) {
    if (!run) return SILENT_OPENING
    let timer = null, grace = null, byDeadline = false
    const cut = new Promise((resolve) => {
      timer = timers.setTimeout(() => {
        byDeadline = true
        run.controller.abort()
        grace = timers.setTimeout(() => resolve(SILENT_OPENING), 250)
      }, MANAGED_VOICE.arrivalMs)
      // Cut by Stop (or anything but the deadline): nothing she wrote is waited for.
      run.controller.signal.addEventListener('abort', () => { if (!byDeadline) resolve(SILENT_OPENING) }, { once: true })
    })
    try {
      return await Promise.race([run.words, cut])
    } finally {
      timers.clearTimeout(timer); timers.clearTimeout(grace)
      if (arriving === run.controller) arriving = null
    }
  }

  async function start() {
    if (state !== 'idle') return 'busy'
    const id = ++generation
    seen.clear(); handled.clear(); retrying = null
    awareSince = null; awareAgain = false
    sdk = freshSdk(); pressedAt = clockNow(); clearSdkWatch()
    change('connecting')
    const ask = new AbortController(); pending = ask
    connectTimer = timers.setTimeout(() => { if (current(id)) fail(LINES.connect) }, MANAGED_VOICE.connectMs)
    const askTimer = timers.setTimeout(() => ask.abort(), MANAGED_VOICE.edgeRequestMs)
    let status = 0, body = null
    try {
      const response = await request(VOICE_ROUTE, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'content-type': 'application/json' }, body: MANAGED_SESSION_BODY, signal: ask.signal,
      })
      status = response.status
      body = await response.json().catch(() => null)
    } catch {
      if (!current(id)) return 'stopped'
      // No answer (a network error, or none within 12 s): the orb rests with one line; no other voice starts.
      fail(LINES.unreachable)
      return 'refused'
    } finally {
      timers.clearTimeout(askTimer)
    }
    if (!current(id)) return 'stopped'
    const answer = readSessionAnswer(status, body)
    if (answer.kind === 'off') { fail(answer.line); return 'off' }
    if (answer.kind === 'refused') { fail(answer.line); return 'refused' }
    // After a call dropped as it opened: no arrival turn (her first words could not be sent anyway), no override.
    if (openPlain) return call(id, answer, null)
    const opening = await firstWords(beginArrival())
    if (!current(id)) return 'stopped'
    return call(id, answer, opening)
  }

  /** Puts down one SDK session of this press (its callbacks are dropped from now on) and starts the press again
   *  without the first-message override: the one retry, for a provider that refuses the override (the provider's own
   *  setting then decides how the call opens). */
  function retryWithoutOverride(id, answer) {
    attemptNo++
    closeBridge('disconnected')
    connected = false; conversation = ''
    timers.clearInterval(meter); timers.clearTimeout(durationTimer); meter = durationTimer = null
    clearSdkWatch()
    const old = session; session = null
    end(old)
    change('connecting')
    retrying = call(id, answer, null)
    return retrying
  }

  /**
   * One SDK session for this press. `opening`: her first words ('' opens silent) as the one allowed override, the
   * first-message override; `null` sends no override.
   */
  async function call(id, answer, opening) {
    const attempt = ++attemptNo
    const withOverride = typeof opening === 'string'
    const live = () => current(id) && attempt === attemptNo
    openedWith = ''
    // The override is blamed only before the tab door is ready, and only when the provider's own words name it.
    const overrideRefused = detail => withOverride && !bridgeReady && OVERRIDE_REFUSED_RE.test(detailText(detail))
    /**
     * Whether the provider showed life in this attempt after the SDK connected: her audio playing, a message, a ping,
     * an interruption or a correction. The connect itself is not life (a provider that drops the call connects first).
     */
    let lived = false
    const life = () => { lived = true; alive() }
    // The edge's `turn` and `spoken` frames count too (receive() sits outside this attempt).
    attemptLived = () => { if (live()) lived = true }
    /** When the SDK connected (null before): an end within OPEN_DROP_MS of it is early, whatever the provider sent. */
    let connectedAt = null
    const early = () => connectedAt === null || clockNow() - connectedAt < OPEN_DROP_MS
    /**
     * This attempt ended before any provider life, or early. With the override: dropped as it opened (`openPlain`, one line of
     * its own; `why` as the edge has always been told). Without it: the usual line, never silence (onDisconnect).
     * The provider's own words naming the override (`overrideRefused`, the one retry) are checked first, as before.
     */
    const droppedOpening = () => withOverride && (!lived || early())
    const endDropped = why => { openPlain = true; fail(LINES.droppedOpening, why) }
    let made
    try {
      made = await startSession({
        conversationToken: answer.pass, connectionType: 'webrtc', micMuted: muted, stripAudioTags: true,
        workletPaths: { rawAudioProcessor: WORKLET_PATH },
        ...(withOverride ? { overrides: { agent: { firstMessage: opening } } } : {}),
        onConversationCreated(value) { if (!live()) end(value); else session = value },
        onConnect() {
          if (!live()) return
          // The provider connected: an error it reported while connecting does not count against the call.
          alive()
          connectedAt = clockNow()
          connected = true
          // Her first words are her line in the transcript (the provider's own copy of a line is never shown).
          if (opening) onTranscript('auma', opening, `opening:${String(attempt)}`)
          openedWith = opening || ''
          change('listening')
          durationTimer = timers.setTimeout(() => { if (current(id)) fail(LINES.resting, 'timer') }, answer.seconds * 1000)
          openTabDoor(id)
        },
        onDisconnect(details) {
          if (!live()) return
          if (overrideRefused(details)) { void retryWithoutOverride(id, answer); return }
          // The SDK's own end, at once, as before; only its closed reason and a numeric close code are kept.
          const reason = typeof details?.reason === 'string' && SDK_DISCONNECT_REASONS.includes(details.reason) ? details.reason : null
          const code = [details?.closeCode, details?.context?.code].find(value => Number.isInteger(value) && value >= 0 && value <= 65_535)
          sdk = { ...sdk, disconnectReason: reason, disconnectCode: code ?? null }
          const why = details?.reason === 'error' ? 'error' : 'disconnected'
          if (droppedOpening()) endDropped(why)
          else if (details?.reason === 'error') fail(LINES.disconnected)
          // A call the provider ends before it ever showed life is not a quiet hang-up: the owner is told.
          else if (!lived || early()) fail(LINES.disconnected, 'disconnected')
          else stop(true, 'disconnected')
        },
        onError(message, context) {
          if (!live()) return
          // Checked first, as before: the provider refusing the first-message override is the one retry.
          if (overrideRefused(message) || overrideRefused(context)) { void retryWithoutOverride(id, answer); return }
          // the voice tools part 2: an SDK error alone does not end the call (its onDisconnect does). It is counted in closed
          // fields, and the call ends as before only if nothing shows life for SDK_WATCH_MS (a later error does not
          // push that back).
          sdk = {
            ...sdk, errors: sdk.errors + 1, kind: classifySdkError(message, context),
            lastErrorSeconds: Math.max(0, Math.floor((clockNow() - pressedAt) / 1000)),
          }
          if (sdkWatch === null) {
            sdkWatch = timers.setTimeout(() => {
              sdkWatch = null
              if (!live()) return
              if (droppedOpening()) endDropped('error')
              else fail(LINES.disconnected)
            }, SDK_WATCH_MS)
          }
        },
        onModeChange(update) {
          if (!live()) return
          // Only her audio playing is life: in WebRTC mode 'listening' is also what her audio simply stopping looks like.
          if (update?.mode === 'speaking') life()
          if (update?.mode === 'listening' || update?.mode === 'speaking') change(update.mode)
        },
        // The provider's own heartbeat (SDK 1.36.0 BaseConversation handlePing): a quiet call is still a live one.
        onPing() { if (live()) life() },
        // ONLY THE EDGE DECIDES AN INTERRUPTION. His talking over her is a sign of life and
        // the call listens again; it no longer cancels any turn here. The edge already judges his words (a handed turn
        // is never cut by them) and sends `cancel` for a turn it cuts; Stop and the call ending cut the rest.
        onInterruption() {
          if (!live()) return
          life()
          change('listening')
        },
        onMessage(message) {
          if (!live() || !message || typeof message !== 'object') return
          life()
          const role = message.role === 'user' ? 'you' : 'auma'
          const key = `${role}:${String(message.event_id ?? message.response_id ?? '')}`
          if (seen.has(key)) return
          seen.add(key)
          // Her line on screen is HER OWN text as it streams (runTurn); the provider's copy of it is not shown twice.
          if (role !== 'you') return
          const text = String(message.message ?? '').trim()
          if (!text) return
          change('thinking')
          onTranscript('you', text, key)
        },
        onAgentResponseCorrection(correction) {
          if (!live()) return
          life()
          onCorrection(String(correction?.original_agent_response ?? ''), String(correction?.corrected_agent_response ?? ''))
        },
      })
    } catch (error) {
      if (!live()) return current(id) && retrying ? retrying : 'stopped'
      if (error?.name !== 'NotAllowedError' && overrideRefused(error)) return retryWithoutOverride(id, answer)
      // A refused microphone is the owner's browser, never the provider: it says how to allow it, as before.
      if (error?.name !== 'NotAllowedError' && droppedOpening()) endDropped('error')
      else fail(error?.name === 'NotAllowedError' ? LINES.micDenied : LINES.connect)
      return 'refused'
    }
    if (!live()) { end(made); return current(id) && retrying ? retrying : 'stopped' }
    session = made; pending = null
    try { session.setMicMuted(muted) } catch { /* the SDK keeps its own capture state */ }
    meter = timers.setInterval(() => {
      if (!current(id) || !session) return
      let mic = 0, say = 0
      try { mic = muted ? 0 : session.getInputVolume(); say = session.getOutputVolume() } catch { /* a closing call */ }
      onLevels(clampLevel(mic), clampLevel(say), thinking())
    }, MANAGED_VOICE.meterMs)
    openTabDoor(id)
    return 'started'
  }

  /** Typing during a live call goes into the same conversation; anything else is the page's own typed path. */
  function sendText(text) {
    const words = String(text ?? '').trim().slice(0, MANAGED_VOICE.typedChars)
    if (!words) return 'empty'
    if (!session || !connected) return 'not-live'
    onTranscript('you', words, `typed:${++typedId}`)
    try { session.sendUserActivity(); session.sendUserMessage(words) } catch { return 'sent' }
    change('thinking')
    return 'sent'
  }

  return {
    start, sendText,
    /** The owner's Stop: everything is cut, her carried turns too. */
    stop: () => stop(false),
    setMuted(value) { muted = Boolean(value); try { session?.setMicMuted(muted) } catch { /* the SDK keeps its own capture state */ } },
    get state() { return state },
    get connected() { return Boolean(session) && connected },
    get openTurns() { return turns.size },
    /** the voice tools part 2: closed fields only (see `sdk` above); a copy, so the page cannot change it. `openPlain`: a call
     *  dropped as it opened, so presses send no first-message override until the page reloads (never sent to the edge). */
    get status() { return { sdk: { ...sdk }, openPlain: openPlain === true } },
  }
}
