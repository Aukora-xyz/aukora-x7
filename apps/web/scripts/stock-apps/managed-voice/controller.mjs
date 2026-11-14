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
  BRIDGE_PATH, CALL_END_REASONS, CONVERSATION_ID_RE, FAIL_CODE_RE, FAIL_CODES, LINES, MANAGED_SESSION_BODY, MANAGED_VOICE,
  NOT_SIGN_IN_CODES, OFF_CODES, OFF_STATUSES, REFUSAL_LINES, SIGN_IN_STATUSES, SILENT_OPENING, TURN_ID_RE, VOICE_ROUTE,
  WORKLET_PATH,
} from './policy.mjs'

const utf8 = value => new TextEncoder().encode(value).byteLength
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
 * @param {(turn: { turnId: string, transcript: string, signal: AbortSignal, say: (text: string) => void, carry: () => void }) => Promise<{ ok: true } | { ok: false, code: string }>} deps.runTurn
 *   `carry()` (called by her turn at voice level open): when the CALL ends by anything but the owner's Stop (the edge's
 *   end, the provider hanging up, the tab door dropping, the call's own deadline), this turn is let go, not cut: her work
 *   goes on in her thread and her answer lands there and in the transcript; nothing more goes up the tab door for it.
 *   The owner's interruption and Stop still cut it at once.
 * @param {(press: { signal: AbortSignal }) => Promise<string>} [deps.arrival]  her first words (governed-turn.mjs
 *   createArrivalRunner): started once the edge answers with a call, waited for at most MANAGED_VOICE.arrivalMs.
 *   Without it, or when she writes nothing in time, the call opens silent.
 */
export function createManagedConversation({
  startSession, request, openBridge, runTurn, arrival = null,
  onState = () => {}, onTranscript = () => {}, onCorrection = () => {}, onLevels = () => {}, onNotice = () => {},
  timers = globalThis, muted: initiallyMuted = false,
}) {
  let session = null, generation = 0, state = 'idle', pending = null, meter = null
  /** The arrival turn of this press, cut on Stop, on any answer that is not a call, and at its deadline. */
  let arriving = null
  let connectTimer = null, durationTimer = null, connected = false
  // The page's mute state at the moment the controller is made (the owner may have muted before his first press).
  let muted = Boolean(initiallyMuted), typedId = 0
  // Each SDK session this press opens; a retry without the first-message override is a second attempt.
  let attemptNo = 0, retrying = null
  let bridge = null, bridgeReady = false, conversation = ''
  const seen = new Set()
  /** Her turns open now, by the edge's turn id. */
  const turns = new Map()
  /** Her turns that outlived their call (`carry`): still running in her thread, cut only by the owner's Stop. */
  const carried = new Set()
  /** Every turn id this call has run: one governed turn per id, whatever the edge sends twice. */
  const handled = new Set()

  const change = next => { if (state !== next) { state = next; onState(next) } }
  const current = id => id === generation
  const end = value => { if (value) { try { void Promise.resolve(value.endSession()).catch(() => {}) } catch { /* already ended */ } } }
  const thinking = () => [...turns.values()].some(turn => !turn.spoke && !turn.controller.signal.aborted)

  function stopTimers() {
    timers.clearInterval(meter); timers.clearTimeout(connectTimer); timers.clearTimeout(durationTimer)
    meter = connectTimer = durationTimer = null
    onLevels(0, 0, false)
  }

  function send(frame) {
    const socket = bridge
    if (!socket || socket.readyState !== 1) return false
    const text = JSON.stringify(frame)
    if (utf8(text) > MANAGED_VOICE.frameBytes) return false
    try { socket.send(text); return true } catch { return false }
  }

  /**
   * `why` the page ends the call, for the edge's call history (voice-bridge-do.mjs BYE_ENDS): 'stop' (the owner's Stop),
   * 'timer' (the call's own duration ran out here), 'disconnected' (the provider hung up), 'error' (anything else).
   */
  function closeBridge(why) {
    const socket = bridge
    bridge = null; bridgeReady = false
    if (!socket) return
    try { if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'bye', why })) } catch { /* closing anyway */ }
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

  function cancelOpenTurns(by) {
    for (const turn of turns.values()) {
      if (turn.controller.signal.aborted) continue
      turn.by = by
      turn.controller.abort()
    }
  }

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

  async function runOne(turnId, transcript, id) {
    const turn = { controller: new AbortController(), seq: 0, spoke: false, by: '', carry: false, released: false }
    turns.set(turnId, turn)
    handled.add(turnId)
    if (state === 'listening') change('thinking')
    let outcome
    try {
      outcome = await runTurn({
        turnId, transcript, signal: turn.controller.signal, say: text => delta(turnId, text, id),
        carry: () => { turn.carry = true },
      })
    } catch {
      outcome = { ok: false, code: FAIL_CODES.failed }
    } finally {
      if (turns.get(turnId) === turn) turns.delete(turnId)
      carried.delete(turn)
    }
    // Carried past its call: her answer is in her thread and the transcript; the edge has closed this turn already.
    if (turn.released || !current(id)) return
    if (turn.controller.signal.aborted) {
      // Cut by the provider's interruption: the edge is told. Cut by the edge itself, or by Stop: nothing more to say.
      if (turn.by === 'interrupted') send({ t: 'fail', turn: turnId, code: FAIL_CODES.cancelled })
      return
    }
    // A turn that said anything (her words, or the page's own sentence for it: a look-only refusal, a quiet or failed
    // turn) ends with `done`, so the edge speaks what it holds; `fail` is for a turn with nothing to say.
    if (outcome?.ok === true || turn.spoke) send({ t: 'done', turn: turnId })
    else send({ t: 'fail', turn: turnId, code: typeof outcome?.code === 'string' && FAIL_CODE_RE.test(outcome.code) ? outcome.code : FAIL_CODES.failed })
  }

  function receive(data, id) {
    if (typeof data !== 'string' || utf8(data) > MANAGED_VOICE.frameBytes) return
    let frame
    try { frame = JSON.parse(data) } catch { return }
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return
    if (frame.t === 'ready') {
      if (frame.conv !== conversation) { fail(LINES.link); return }
      bridgeReady = true
      timers.clearTimeout(connectTimer); connectTimer = null
      return
    }
    if (!bridgeReady) return
    if (frame.t === 'end') { fail(LINES.ended); return }
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
    if (frame.t !== 'turn') return
    const turnId = typeof frame.turn === 'string' && TURN_ID_RE.test(frame.turn) ? frame.turn : ''
    if (!turnId || handled.has(turnId)) return
    const transcript = typeof frame.transcript === 'string' ? frame.transcript.trim() : ''
    if (!transcript || transcript.length > MANAGED_VOICE.transcriptChars) {
      handled.add(turnId)
      send({ t: 'fail', turn: turnId, code: FAIL_CODES.invalid })
      return
    }
    // He asks something new while turns carried past an earlier call still run: her session takes prompts in queue
    // mode, so his new turn would wait silently behind them. The new turn is his interruption: they are cut at once.
    for (const turn of carried) { turn.by = 'interrupted'; turn.controller.abort() }
    carried.clear()
    if (turns.size >= MANAGED_VOICE.maxOpenTurns) {
      handled.add(turnId)
      send({ t: 'fail', turn: turnId, code: FAIL_CODES.busy })
      return
    }
    void runOne(turnId, transcript, id)
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
    // The override is blamed only before the tab door is ready, and only when the provider's own words name it.
    const overrideRefused = detail => withOverride && !bridgeReady && OVERRIDE_REFUSED_RE.test(detailText(detail))
    let made
    try {
      made = await startSession({
        conversationToken: answer.pass, connectionType: 'webrtc', micMuted: muted, stripAudioTags: true,
        workletPaths: { rawAudioProcessor: WORKLET_PATH },
        ...(withOverride ? { overrides: { agent: { firstMessage: opening } } } : {}),
        onConversationCreated(value) { if (!live()) end(value); else session = value },
        onConnect() {
          if (!live()) return
          connected = true
          // Her first words are her line in the transcript (the provider's own copy of a line is never shown).
          if (opening) onTranscript('auma', opening, `opening:${String(attempt)}`)
          change('listening')
          durationTimer = timers.setTimeout(() => { if (current(id)) fail(LINES.resting, 'timer') }, answer.seconds * 1000)
          openTabDoor(id)
        },
        onDisconnect(details) {
          if (!live()) return
          if (overrideRefused(details)) { void retryWithoutOverride(id, answer); return }
          if (details?.reason === 'error') fail(LINES.disconnected)
          else stop(true, 'disconnected')
        },
        onError(message, context) {
          if (!live()) return
          if (overrideRefused(message) || overrideRefused(context)) { void retryWithoutOverride(id, answer); return }
          fail(LINES.disconnected)
        },
        onModeChange(update) { if (live() && (update?.mode === 'listening' || update?.mode === 'speaking')) change(update.mode) },
        onInterruption() {
          if (!live()) return
          cancelOpenTurns('interrupted')
          change('listening')
        },
        onMessage(message) {
          if (!live() || !message || typeof message !== 'object') return
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
          onCorrection(String(correction?.original_agent_response ?? ''), String(correction?.corrected_agent_response ?? ''))
        },
      })
    } catch (error) {
      if (!live()) return current(id) && retrying ? retrying : 'stopped'
      if (error?.name !== 'NotAllowedError' && overrideRefused(error)) return retryWithoutOverride(id, answer)
      fail(error?.name === 'NotAllowedError' ? LINES.micDenied : LINES.connect)
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
  }
}
