// THE MANAGED VOICE'S NUMBERS AND WORDS, in one place.
// The provider's approved settings live at the edge and at the provider; these are only what the page itself enforces.

/** The one route the page asks, and the one body it sends (the edge refuses anything else). */
export const VOICE_ROUTE = '/_host/voice'
export const MANAGED_SESSION_BODY = '{"action":"managed_session"}'
/** The tab door: a same-origin WebSocket to the edge, owner's cookie, JSON text frames. */
export const BRIDGE_PATH = '/_host/voice/bridge'
/** The SDK's capture worklet, self-hosted and byte-copied from the pinned SDK by the build. */
export const WORKLET_PATH = '/app/eleven-raw-audio.js'

export const MANAGED_VOICE = Object.freeze({
  /** A call is allowed between one and twenty minutes; the edge's answer picks the number inside that. */
  minSeconds: 60,
  maxSeconds: 1200,
  /** From the press to a connected call with the tab door ready. */
  connectMs: 25_000,
  /** The edge's answer to `managed_session`. */
  edgeRequestMs: 12_000,
  /** How often the two volumes are read for the field and the Pentora. */
  meterMs: 50,
  /** Every frame on the tab door, either way (but `aware`, below). */
  frameBytes: 8192,
  /** the voice tools V6: the `aware` frame this page sends may be this large (voice-bridge-do.mjs AWARE_FRAME_MAX_BYTES). */
  awareBytes: 32768,
  /** The edge's `memory` frame may be this large (DESIGN.md: at most 8 items and 48,000 bytes a frame). */
  memoryFrameBytes: 48_000,
  /** At most this many items in one `memory` frame. */
  memoryItems: 8,
  /** At most this many code points of her text per `delta` frame (always under `frameBytes` once encoded). */
  deltaCodePoints: 1024,
  /** At most this many of her turns open at once; a further one is refused, never queued in the page. */
  maxOpenTurns: 4,
  /** A transcript the edge hands over is at most this long (the journal takes no more). */
  transcriptChars: 4000,
  /** A typed line sent into a live call is cut at this length. */
  typedChars: 4000,
  /** Her turn: the first sign of life, then the longest quiet (the same numbers as today's spoken turn). */
  firstEventMs: 18_000,
  idleMs: 22_000,
  /**
   * HER TURN AT VOICE LEVEL OPEN (her voice is her, whole: internet, tools, everything).
   * A tool run takes 10 to 120 seconds, so at open her turn is never cut for a short quiet: the first sign of life within
   * a minute, then at most three minutes between any two events of her session, and one ceiling of ten minutes for the
   * whole turn. The owner's interruption and Stop still cut at once. Any other level keeps the two numbers above.
   */
  openFirstEventMs: 60_000,
  openIdleMs: 180_000,
  openTurnMs: 600_000,
  /**
   * HER FIRST WORDS (2026-11-14). The press waits at most this long after the edge's answer for what she writes when the
   * voice opens (her arrival turn, started once the edge answers with a call); then the call opens with what she wrote,
   * or silent.
   */
  arrivalMs: 4000,
  /** Her first words are cut to this many code points (at a sentence end when there is one) for the first-message override. */
  openingCodePoints: 500,
})

/** The first-message override that opens a call silent: no canned line, she speaks when he does. */
export const SILENT_OPENING = ''

/** A turn id the edge's journal accepts (voice-director.mjs TURN_ID_RE). */
export const TURN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
/** A provider conversation id, as the page announces it in `hello`. */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/** Answers that mean "no managed voice here": the orb rests with the "not set up" line (REFUSAL_LINES.VOICE_NOT_CONFIGURED)
 * and no other voice starts (the managed voice is the voice). With its switch off the edge
 * does not know the action at all (400 VOICE_ACTION_INVALID, exactly as on a host without it). */
export const OFF_CODES = Object.freeze(['VOICE_ACTION_INVALID'])
export const OFF_STATUSES = Object.freeze([404, 501])
/** Answers that mean "the owner is not signed in with his fingerprint on this browser" (LINES.signIn): a 401, or a 403
 * that is not the edge's same-origin refusal (that one is not about sign-in: LINES.unreachable). */
export const SIGN_IN_STATUSES = Object.freeze([401, 403])
export const NOT_SIGN_IN_CODES = Object.freeze(['SAME_ORIGIN_BROWSER_REQUIRED'])

/** The edge's closed list of refusals, each with the one line shown where the orb's status line already is. */
export const REFUSAL_LINES = Object.freeze({
  VOICE_NOT_CONFIGURED: 'My voice is not set up on this host yet. Typing works.',
  VOICE_QUOTA: 'My voice is resting for today. We can keep talking in text.',
  VOICE_PROVIDER_UNAVAILABLE: 'My voice service is not answering right now. Keep typing, or try the orb again later.',
  VOICE_BUSY: 'My voice is already open in another window. Close it there, or keep typing here.',
})

export const LINES = Object.freeze({
  connect: 'Voice could not connect. Tap the orb to try again, or keep typing.',
  resting: 'My voice is resting. We can keep talking in text.',
  disconnected: 'Voice disconnected. Tap the orb to reconnect, or keep typing.',
  /** A call that carried her first words ended before the provider showed any life (it may refuse the first-message
   *  override without saying so): until the page reloads, the next press opens without them (controller.mjs openPlain). */
  droppedOpening: 'Voice dropped as it opened. Tap the orb to try once more, or keep typing.',
  micDenied: 'Allow microphone access, then tap the orb again.',
  link: 'My voice lost its link to me. Tap the orb to reconnect, or keep typing.',
  ended: 'Voice ended. Tap the orb to talk again, or keep typing.',
  /** The edge could not record a turn it heard, so it ran nothing and said nothing for it. */
  unjournaled: 'I heard you, but could not record that turn, so I did not answer it. Say it again?',
  /** The edge answered 401/403: the owner has no fingerprint session on this browser. No other voice starts. */
  signIn: 'My voice needs your fingerprint sign-in on this browser. Typing works.',
  /** The managed module did not load, or the edge answered a 5xx, a bad body, or nothing in 12 s. No other voice starts.
   *  aumalive.js keeps a copy of this line (VOICE_UNREACHABLE_LINE) for the one case it says itself: the module did not load. */
  unreachable: 'My voice is not reachable right now. Typing works.',
})

/** The form of every code a `fail` frame carries (the edge accepts this and nothing else). */
export const FAIL_CODE_RE = /^[A-Z_]{3,40}$/
/** The codes a `fail` frame carries (page to edge). */
export const FAIL_CODES = Object.freeze({
  lookOnly: 'VOICE_LOOK_ONLY_REFUSED',
  failed: 'VOICE_TURN_FAILED',
  timeout: 'VOICE_TURN_TIMEOUT',
  /** Her turn at level open reached its ten-minute ceiling. */
  ceiling: 'VOICE_TURN_CEILING',
  cancelled: 'VOICE_TURN_CANCELLED',
  invalid: 'VOICE_TURN_INVALID',
  busy: 'VOICE_TURN_BUSY',
})

/** The sentences the page itself says for a turn (the same words as today's spoken path in aumalive.js). */
export const TURN_LINES = Object.freeze({
  quiet: 'My thinking channel went quiet before the answer arrived. I reset it — say that once more.',
  flicker: 'The channel flickered — I lost my thread. Say it again?',
  noWords: 'I heard you, but my thinking channel returned no words. Say it once more.',
  recordFailed: 'This turn could not be secured in its thread, so I did not send it.',
  selfTooLong: 'My full answer is in the transcript; part of it cannot be read aloud.',
  /** Her turn at level open reached its ten-minute ceiling (MANAGED_VOICE.openTurnMs). */
  ceiling: 'That took longer than ten minutes, so I stopped it. Ask me again if you still want it.',
})

/**
 * Why the edge cut a running turn when it ended the CALL (voice-bridge-do.mjs endConversation): the call is over, not
 * her turn. At level open such a turn carries on in her thread (her answer lands in her voice thread and the
 * transcript); at any other level it is cut, as before.
 */
export const CALL_END_REASONS = Object.freeze(['deadline', 'provider-closed', 'unclaimed', 'journal-unavailable'])

/**
 * HER FAST VOICE'S AWARENESS. Once the tab door is ready
 * the page sends `aware` (genesis-live.js voiceAwareness) at once, after each of her turns, and every AWARE_EVERY_MS
 * while the call is open. The bridge sends `spoken` for each exchange its fast voice had (his words, her words).
 */
export const AWARE_EVERY_MS = 10_000
/** A push still gathering after this long no longer holds the next one back (its late answer is dropped). */
export const AWARE_STUCK_MS = 5_000
/** The longest `heard` and `said` a `spoken` frame carries (voice-fast.mjs SPOKEN_LIMITS). */
export const SPOKEN_CHARS = Object.freeze({ heard: 1000, said: 1200 })

/**
 * HER FAST VOICE'S TOOLS. The bridge sends `tool` (turn,
 * call, name, arguments as the model wrote them); this page runs it with her own tools through her worker's look-only
 * check (genesis-live.js voiceTool) and answers `tool_result`. One call may take at most `toolMs` here; its text is cut
 * to `toolResultBytes` (UTF-8) with a plain note, and again so its whole frame fits the tab door. `tool_cancel` stops
 * every call of that turn (nothing is answered for them).
 */
export const FAST_TOOLS = Object.freeze({ toolMs: 8000, toolResultBytes: 6144, argsBytes: 4096, nameChars: 64, openCalls: 8, noteBytes: 96 })
/** Said when his words were queued in the conversation he named (that conversation answers later, in its own thread). */
export const HANDED_NAMED_LINE = 'Done: it is queued in that conversation, after whatever it is doing now.'
/** A call id the bridge names (voice-bridge-do.mjs TOOL_CALL_ID_RE). */
export const TOOL_CALL_RE = /^call_[1-9][0-9]{0,2}$/

/**
 * A PROVIDER ERROR ALONE NO LONGER ENDS HER CALL (the voice tools part 2, 2026-11-16). The SDK's `onError` reports errors that
 * do not end the call (one turn's server error around a cancelled reply, a tool call); its own `onDisconnect` is the end.
 * After an `onError` the call ends only if neither the provider nor the bridge shows life for SDK_WATCH_MS. What the SDK
 * said is never kept or sent: it is read once, here, into one closed kind (the edge's voice-bridge.mjs VOICE_SDK_KINDS).
 */
export const SDK_WATCH_MS = 20_000
/** A call the provider ends within this long of the SDK connecting was dropped as it opened, whatever it sent in that
 *  moment (a ping or a first audio packet can come just before the drop). */
export const OPEN_DROP_MS = 8000
export const SDK_ERROR_KINDS = Object.freeze(['socket', 'server', 'audio', 'permission', 'other'])
/** The SDK's own closed disconnect reasons (its DisconnectionDetails), the only ones kept. */
export const SDK_DISCONNECT_REASONS = Object.freeze(['user', 'agent', 'error'])
/** The fixed table, first match wins: a provider "Server error" is `server` whatever else it says. */
const SDK_ERROR_TABLE = Object.freeze([
  ['server', /\bserver\b|\binternal\b|rate[ _-]?limit|quota/i],
  ['permission', /permission|not[ _-]?allowed|denied/i],
  ['audio', /audio|microphone|worklet|media|device/i],
  ['socket', /socket|webrtc|connection|network|livekit|\bice\b|peer|closed|disconnect/i],
])
/** The closed kind of one SDK error, from its message and the string fields of its context (nothing else is read). */
export function classifySdkError(message, context) {
  const parts = [typeof message === 'string' ? message : '']
  if (context && typeof context === 'object') {
    for (const name of ['errorType', 'type', 'name', 'message', 'reason']) {
      let value
      try { value = context[name] } catch { value = undefined }
      if (typeof value === 'string') parts.push(value)
    }
  }
  const text = parts.join(' ').slice(0, 2000)
  for (const [kind, pattern] of SDK_ERROR_TABLE) if (pattern.test(text)) return kind
  return 'other'
}
