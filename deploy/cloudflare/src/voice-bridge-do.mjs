/** The VoiceBridge Durable Object: one for the world (the provider's socket arrives before any conversation id is known).
 *
 * It holds at most the provider socket and the owner's tab socket of each live conversation (at most two), and in its
 * own storage one small record: the admission counters and the live slots (each slot is one conversation's binding to
 * the owner, his HEAD seed and its reserved duration). It never holds her session, her files or a key.
 *
 * NO SPEECH WITHOUT AN ANNOUNCED TAB AND A JOURNAL ROW. The provider's `user_transcript` with event id N is first the
 * interruption of whatever turn came before it (that turn is cancelled before N's own text is judged). A usable N is
 * held (only the newest is kept) until the owner's tab has said `hello` for this conversation and no cancel of an older
 * turn is still unconfirmed; then it is journaled through HEAD's EXISTING turn journal as a spoken turn (`modality:
 * voice`, so `voiceAuthority: none` and the role `voice-transcript-unconfirmed`, hashes and byte count only, never the
 * words), idempotent by the turn id `eleven:<conversation>:<N>`, and only then sent to the tab as `turn`. A turn whose
 * journal write is not confirmed is never run and never answered with words: the provider gets the empty final, the
 * tab gets `cancel` with the reason `unjournaled`, and it is counted. The one fixed honest sentence is ONLY for a turn
 * that was journaled and whose tab then went away.
 * Her streamed text comes back as `delta` frames; it is gathered into clauses (an inline code span is never split;
 * plain prose may go out early at a comma, semicolon, colon or dash: SOFT_CLAUSE_MIN_CHARS),
 * `[field ...]` tags are stripped, and each clause must pass the EXISTING speakable-clause rules (voice-director.mjs
 * validateSpeakableClause) before it goes to the provider. A refused clause is dropped and counted, never sent, and when
 * it was cut (the 600-character cap) the refusal holds to the end of its token and clause.
 * Terminal journal writes (complete, cancel, abandon) are retried (5 tries, spaced) and counted; while a cancel is
 * unconfirmed the next turn of that conversation waits, and if it stays unconfirmed the conversation ends.
 * Every socket event, timer and admission call runs one at a time (`serial`), so a turn's journal write, its cancel and
 * its deltas are never interleaved. The two cues (early, timeout) alone run on their own clock (they only read state).
 *
 * THE FAST PATH. Unless the edge setting VOICE_FAST is 'off' (and while the fast
 * provider's key binding is set), the bridge answers a turn ITSELF: the fast model call starts at the same moment as the
 * turn's journal write (through HEAD's budget, journal and provider dispatcher; the key never reaches this object), and
 * its text is HELD, never released, until that journal write is confirmed. An unconfirmed journal write aborts the call
 * and says nothing, as before. Her fast words go out through the same clause release and the same speakable rules as her
 * governed words; the tab never gets the turn. The governed hand-off (the `turn` frame, unchanged) is the fallback, at
 * most once, and never after a fast word was spoken: when the call fails, or no text came within
 * FAST_VOICE_LIMITS.firstTextMs. The model's one tool (`hand_to_session`) hands the owner's spoken words to the tab as a
 * governed turn after her one short line; its arguments are never read. The tab sends `aware` (her page's read-only
 * awareness, kept with its arrival time and given to the model as quoted data) and gets `spoken` (each fast exchange).
 * HER FAST VOICE'S TOOLS. The fast model may call her own tools (voice-fast.mjs `look`): the
 * bridge NEVER runs one. It names each call itself (`call_<n>`) and sends her tab `tool` (turn, call, name, the arguments
 * exactly as the model wrote them, size-checked); her tab runs it under her worker's look-only rule and answers
 * `tool_result` (bounded). No answer within FAST_VOICE_LIMITS.toolWaitMs, or no tab: the model is told the tool did not
 * answer. Up to FAST_VOICE_LIMITS.toolRounds rounds and toolCalls calls, the whole turn within turnMs; each model call is
 * budgeted and journaled under its own id (`<turn>.fast`, then `<turn>.fast2` ...), exactly as the single fast call was.
 * On the first tool call of a turn with nothing said yet she says one short cue (TOOL_CUE, a cue, never her answer). Tool
 * calls go to the tab only once the spoken turn's journal write is confirmed. A newer transcript (not a backchannel) cuts
 * the turn: its pending calls are answered as cancelled here, the tab is sent `tool_cancel`, and a late result is dropped.
 * HER VOICE MEMORY. Every finished exchange (answered,
 * cut, handed when its `done` arrives, failed, refused, with words said or a cut turn's reads) becomes ONE chain record
 * and its words record, written in one storage transaction with the head and the tail (MEMORY_KEYS: the head, the last
 * MEMORY_LIMITS.tail pairs, the seq her home acknowledged), for the same owner. Nothing in it lapses with time. A fast
 * prompt opens with the last SPOKEN_LIMITS.exchanges of the tail, word for word, those of an earlier call with their age.
 * The old 30-minute spoken store (LEGACY_SPOKEN_KEY) is deleted when first seen, never converted. These are the only
 * words the bridge stores; the journal still holds hashes only.
 */
import { NIGHTLY_PAGE_ROUTE, nightlyPageResponse } from './nightly-copy.mjs'

import { validateSpeakableClause, idleVoiceDirective, VOICE_CLAUSE_MAX_CHARS } from './voice-director.mjs'
import { VOICE_BRIDGE_PROTOCOL, VOICE_FAILURE_STAGES, VOICE_SDK_KINDS, VOICE_STATUS_COUNTS, VOICE_TOOL_NAMES, readProviderSettings } from './voice-bridge.mjs'
// The closed lists of the history (VOICE_CALL_ENDS, VOICE_TURN_OUTCOMES) live in voice-bridge.mjs, beside the status read.
import { VOICE_CONNECT_GRACE_MS, VOICE_CONNECT_WINDOW_MS, VOICE_MINT_WINDOW_MS, VOICE_SESSION_LIMITS, admissionPeriods, validDurationSeconds } from './voice-session-policy.mjs'
import { CONVERSATION_ID_RE, EVENT_ID_MAX, PROVIDER_FRAME_MAX_BYTES, PROVIDER_TRANSCRIPT_MAX_CHARS, SPEECH_ENGINE_ADAPTER, SPEECH_ENGINE_TIMEOUT_SECONDS } from './voice-provider-speech-engine.mjs'
import { providerRequestReservation } from './provider-budget.mjs'
import {
  FAST_SEARCH_QUERY_CHARS, FAST_VOICE_LIMITS, HAND_OFF_TEXT_RE, HAND_OFF_TITLE_CHARS, HAND_OFF_UNSURE_LINE, SEARCH_LINES, heardNamesTitle, outwardLook, searchHeard, HAND_OFF_TOOL, SPOKEN_CUT, SPOKEN_HANDED, TOOL_CUE_WORDS, TOOL_LIMIT_LINE,
  TOOL_NAME_RE, awarenessMessage, boundedResult, createSseReader, exchangeOf, fastRequestBody, fastVoiceSettings, memoryHistory, toolResultContent,
  validAwareFrame, LOOK_TOOL, SCRATCH_TOOL, addedWordsText, ADDED_DROPPED_LINE, voiceFacts, DIGEST_LINE, pendingDigest, readDigest,
  FAST_ANTHROPIC_BETA, FAST_CLAUDE_MODEL_RE, FAST_REFUSAL_LINE, createAnthropicSseReader, fastAnthropicBody,
  FAST_EFFORT_LEVELS, THINK_LEVELS, THINK_LINES, THINK_TOOL, effortRank, isDeepEffort, ownerEffort, councilAsked,
} from './voice-fast.mjs'
import { MEMORY_KEYS, MEMORY_LIMITS, ZERO_DIGEST, answerDigest, cutWords, makeExchange, makeGap, recordDigest } from './voice-memory.mjs'

export const TAB_FRAME_MAX_BYTES = 8192
/** the voice tools V6: the `aware` frame alone may be this large (every other tab frame stays under TAB_FRAME_MAX_BYTES). */
export const AWARE_FRAME_MAX_BYTES = 32768
export const TAB_TEXT_MAX_CHARS = 4000
export const HELLO_WAIT_MS = 10000
export const INIT_WAIT_MS = 10000
/** How long a conversation waits for its owner tab (before the first hello, or after the tab is gone). */
export const PROVIDER_HOLD_MS = 10000
export const BACKCHANNEL_LEAD_MS = 1500
export const JOURNAL_DEADLINE_MS = 5000
/** The bridge's bounds, each with its own cleanup (voice-bridge.md, "Bounds"). */
export const BRIDGE_LIMITS = Object.freeze({
  /** Her gathered, not yet spoken text of one turn (UTF-8 bytes): over it, the text is dropped to the next clause end. */
  pendingBytes: 65536,
  /** Reply chunks kept per turn to answer a provider retry: over it the oldest go, and a retry gets the empty final. */
  replyChunks: 256,
  /** Bytes waiting on one socket behind the frame in hand, before validation: over it the socket is closed. */
  queuedBytes: 65536,
  /** Sockets before `hello` or `init`, tabs and providers together: one more is closed at once. */
  waitingSockets: 8,
  /** Tries of one terminal journal write (complete, cancel, abandon). */
  journalTries: 5,
})
/** The spacing of a terminal journal write's retries (after try 1, 2, 3, 4). */
export const JOURNAL_RETRY_MS = Object.freeze([1000, 2000, 4000, 8000])
/** The one honest sentence when her tab is not there to answer a journaled turn (the whole reply). */
export const LOST_PLACE = 'I lost my place for a moment. Say that again?'
/** A cue's words, taken ONLY from voice-director.mjs's closed list (a word not on it fails at load), with the
 * provider's documented buffer suffix. */
function cueWords(words) {
  const found = idleVoiceDirective().allowedBackchannels.find(item => item === words)
  if (found === undefined) throw new Error(`voice cue not on the closed list: ${words}`)
  return `${found}... `
}
/** The timeout-protection cue (voice-director.mjs's list), with the provider's documented buffer suffix. */
export const BACKCHANNEL = cueWords('one sec')
/**
 * THE EARLY CUE (2026-11-16): one acknowledgement per turn, EARLY_CUE_MS after the transcript ARRIVED, only while the
 * turn runs and she has said no word yet; cancelled by her first words, never repeated, never said for a turn that was
 * interrupted or ended. Its words come from the same allowed list as the timeout cue; the timeout cue keeps its place.
 */
export const EARLY_CUE_MS = 2500
export const EARLY_CUE = cueWords('mm-hm')
/**
 * 2026-11-18,
 * The early acknowledgement ("mm-hm", "hmm") is said only when VOICE_EARLY_CUE is exactly "on"
 * (wrangler.toml ships "off"). Every cue that says something true stays as it was: "one sec, looking" on a look, the
 * work cues, the provider-wait "one sec", the deep-turn lines and "I'm here".
 */
export const earlyCueOn = env => env?.VOICE_EARLY_CUE === 'on'
/**
 * A CUE SAYS ONLY WHAT IS TRUE AT THAT INSTANT. Every cue of a turn that is not governed-only is
 * chosen from the turn's state (cueState) at the moment it is said, and the first one from the kind of his words
 * (heardQuestion). The timings, the three-a-turn bound, the deep keep-alive, cancel and carry are unchanged.
 *  - FIRST_CUES: the early cue, "hmm" when his words are a question, "mm-hm" otherwise (a governed-only turn keeps
 *    EARLY_CUE, "mm-hm").
 *  - STATE_CUES: the work cues, in order, never one twice in a turn; when the state's words are used up nothing is said
 *    for it (silence is better than a repeat). TOOL_CUE is the first looking word (it uses it up).
 *  - The provider-wait cue (backchannel): the next unused words of the state, or BACKCHANNEL ("one sec") when they are
 *    used up or no state fits (a governed-only turn: always "one sec").
 *  - PRESENCE_CUES: his "are you there", answered with the state.
 */
export const FIRST_CUES = Object.freeze({ question: cueWords('hmm'), statement: EARLY_CUE })
export const STATE_CUES = Object.freeze({
  thinking: Object.freeze([cueWords('let me think'), cueWords('thinking it through')]),
  looking: Object.freeze([cueWords(TOOL_CUE_WORDS), cueWords('still looking')]),
  composing: Object.freeze([cueWords('putting it together'), cueWords('almost there')]),
  handed: Object.freeze([cueWords('my working self is on it')]),
})
export const PRESENCE_CUES = Object.freeze({ thinking: cueWords("I'm here, thinking"), looking: cueWords("I'm here, still looking"),
  composing: cueWords("I'm here, almost there"), handed: cueWords("I'm here; my working self is on it") })
/** The cue on the first tool call of a fast turn (it counts as the turn's early cue: said once, never both).
 * It is the first looking word, so it is never said again as a work cue in that turn. */
export const TOOL_CUE = STATE_CUES.looking[0]
/** The first words of his transcript that make it a question (after the fillers and her name are dropped). */
export const QUESTION_WORDS = Object.freeze(['what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose', 'can', 'could', 'would', 'will', 'should', 'is',
  'are', 'am', 'was', 'were', 'do', 'does', 'did', 'have', 'has'])
const QUESTION_SET = new Set(QUESTION_WORDS)
const WH_WORDS = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose'])
const QUESTION_LEADS = new Set(['hey', 'and', 'but', 'right', 'oh'])
const DOING_WORDS = new Set(['do', 'have'])
const DOING_OBJECTS = new Set(['it', 'a', 'that', 'this'])
/** The closed question test. His words are a question when they end with a question mark (closing quotes,
 * brackets and spaces after it allowed), or when their first word, once the fillers and her name are dropped (as
 * heardWords reads them), is one of QUESTION_WORDS. */
export function heardQuestion(text) {
  if (/\?["'”’)\]\s]*$/u.test(String(text ?? ''))) return true
  const words = heardWords(text)
  let index = 0
  let polite = false
  // Review 2026-11-16: a lead-in word before the first word ("hey Auma what...", "and what about...") does not decide.
  while (index < words.length && (FILLER_SET.has(words[index]) || QUESTION_LEADS.has(words[index]))) { if (words[index] === 'please') polite = true; index++ }
  const word = words[index]
  if (word === undefined) return false
  // Review 2026-11-16: a contraction's question word counts ("what's", "how's", "where's": the part before the apostrophe).
  const first = QUESTION_SET.has(word) ? word : QUESTION_SET.has(word.split("'")[0]) && word.includes("'") ? word.split("'")[0] : null
  if (first === null) return false
  if (WH_WORDS.has(first)) return true
  const next = words[index + 1]
  // Review 2026-11-16: a request or a short reply is not a question: "do it", "have a look", "please do it" (do / have
  // with it, a, that, this, or after "please"), and a bare word or a two-word reply ("will do", "can do", "could be").
  if (DOING_WORDS.has(first) && (polite || next === undefined || DOING_OBJECTS.has(next))) return false
  if (next === undefined || (words.length === index + 2 && (next === 'do' || next === 'be'))) return false
  return true
}
/**
 * The state of a live turn, from what the bridge already tracks. Closed values:
 *  - 'governed': a governed-only turn (the fast voice off);
 *  - 'handed': handed to her working self and running there (a fast hand-off, or a fast turn that fell back);
 *  - 'deep': a deep-effort fast turn whose fast call runs (its own cues stay the effort lane's);
 *  - 'looking': at least one tool call pending at her tab;
 *  - 'composing': the fast call works after at least one tool result came back in this turn;
 *  - 'thinking': the fast call works, no tool call pending, no tool result back yet;
 *  - null: no state fits (her fast call is over and nothing was handed): no cue claims anything then.
 */
export function cueState(turn) {
  if (turn.path === 'governed') return 'governed'
  if (turn.handedAt !== undefined) return 'handed'
  const fast = turn.fast
  if (turn.path !== 'fast' || !fast || fast.status !== 'running') return null
  if (turn.deep) return 'deep'
  if (fast.pending.size > 0) return 'looking'
  if (resultBack(turn)) return 'composing'
  return 'thinking'
}
/** Review 2026-11-16: a tool RESULT came back in this turn (her tab answered ok). A call refused, timed out or cancelled
 * came back with no result: it never makes the turn composing ("almost there" before any result is a false claim). */
const resultBack = turn => (turn.toolLog ?? []).some(entry => entry.result === 'ok')
/** The state a deep turn is actually in under its keep-alive (for its presence cue only). */
function workState(turn) {
  const fast = turn.fast
  if (fast.pending.size > 0) return 'looking'
  return resultBack(turn) ? 'composing' : 'thinking'
}
/** The next words of `state` not yet said in this turn, or null when they are used up. */
function unusedCue(turn, state) {
  return (STATE_CUES[state] ?? []).find(cue => !(turn.cuesSaid ?? []).includes(cue)) ?? null
}
/**
 * NO DEAD AIR ON A DEEP TURN. A fast turn above `medium` (his words asked for it, or the default is that
 * deep) says DEEP_CUE as soon as it runs; her own think_deeper says THINK_CUE once, when the bridge takes it. While such a
 * turn's fast call runs, STILL_THINKING_CUE follows DEEP_CUE_EVERY_MS after the last thing he heard (a cue or her words),
 * under the provider's per-event wait (SPEECH_ENGINE_TIMEOUT_SECONDS); they replace the early and timeout cues while the
 * fast call runs (a hand-off or a fallback gets the normal cues). Cues only: never her answer, never thinking text.
 * Review 2026-11-16: a deep turn that ran out of its bound having said no words says DEEP_FELL_BACK_CUE once before its
 * governed hand-off.
 */
export const DEEP_CUE_EVERY_MS = 12000
/**
 * ONE HONEST CUE WHILE SHE WORKS AFTER SHE HAS SPOKEN. While a fast turn's call or tool round is
 * in flight and nothing was sent for WORK_CUE_AFTER_MS (from the last thing he heard), one short cue; then at most every
 * WORK_CUE_EVERY_MS; at most WORK_CUE_MAX a turn, in this order. Never while a clause of hers is pending. A deep turn keeps
 * its own keep-alive; a turn that has said nothing keeps the early and timeout cues.
 */
export const WORK_CUE_AFTER_MS = 5000
export const WORK_CUE_EVERY_MS = 8000
export const WORK_CUE_MAX = 3
const WORK_CUE_RECHECK_MS = 500
// The work cues are no longer one fixed rotation: each is the next unused words of the turn's state (STATE_CUES).
export const DEEP_CUE = cueWords('let me think that through properly')
export const THINK_CUE = cueWords('give me a moment, I want to think about that properly')
export const STILL_THINKING_CUE = cueWords('still thinking')
export const DEEP_FELL_BACK_CUE = cueWords('that took longer than I can hold here; I am finishing it in my working thread')
/** A tool call id the bridge names (`call_1` .. `call_8`); the model's own ids are never used. */
export const TOOL_CALL_ID_RE = /^call_[1-9][0-9]{0,2}$/
/** The plain lines the model reads when a tool call was not answered by her tab. */
export const TOOL_LINES = Object.freeze({
  noTab: 'The tool did not answer: The owner\u2019s Auma Live tab is not connected.',
  timeout: `The tool did not answer within ${String(FAST_VOICE_LIMITS.toolWaitMs / 1000)} seconds.`,
  cancelled: 'The tool call was cancelled.',
  tooLong: `Not run: its arguments were longer than ${String(FAST_VOICE_LIMITS.toolArgsBytes)} bytes.`,
  notJson: 'Not run: its arguments were not a JSON object.',
  badName: 'Not run: that is not a tool name.',
  // The model is offered `look` and `voice_scratch` (the hand-off never reaches sendTool); a call by
  // any other name (a direct `x6_web_eyes`, `write`, ...) is never sent to the tab, so no rule keyed on `look` is dodged.
  notOffered: 'Not run: that tool is not offered to this voice; call look with the tool name instead.',
  tooMany: `Not run: at most ${String(FAST_VOICE_LIMITS.toolCalls)} tool calls in one spoken turn.`,
  tooLarge: 'Not run: the call was too large to send to the tab.',
})
/**
 * EARLIER SPEECH RELEASE (2026-11-16): while her reply streams, once the pending text is at least SOFT_CLAUSE_MIN_CHARS
 * long and holds no sentence end yet, it may go out at the last comma, semicolon, colon or dash that is followed by
 * whitespace (`softClauseEnd`), unless it ends on a sentence mark (that sentence is whole). Only plain prose is cut
 * there: pending text holding any character that could open a guarded shape (a backtick, a quote, a bracket, a brace,
 * a parenthesis, `<`, `>`, `=`, a slash, a backslash, `|`, `--`) is never cut early and waits for the sentence end as
 * before. Never at `done` (the tail goes whole), never in the clause before a code or JSON block (it still belongs to
 * the block), never to end a discard or a block's tail. A refused early phrase drops the rest of its sentence with it.
 */
export const SOFT_CLAUSE_MIN_CHARS = 32
const SOFT_BOUNDARY = /[,;:]\s+|\s-\s+|[–—]\s+/g
const SOFT_UNSAFE = /[`"()[\]{}<>=\\/|]|--/
export const ADMISSION_KEY = 'voice-bridge:admission'
/** Why the voice did not start: { lastFailure, owner: [...], provider: [...] }, each entry { stage, atMs } from the
 * closed list (VOICE_FAILURE_STAGES), the last 8 kept per door (a stranger's provider-door noise can never push the owner
 * door's record out). A repeat of a door's newest stage only moves its time. Never provider text, a header or an id. */
export const FAILURES_KEY = 'voice-bridge:failures'
export const FAILURES_KEPT = 8
/** A bridge turn id (the journal's `complete` action accepts only this form: turn-journal.mjs BRIDGE_TURN_ID_RE). */
export const BRIDGE_TURN_ID_RE = /^eleven:[A-Za-z0-9_-]{1,96}:\d{1,10}$/
/** A `fail` code from the tab. */
export const FAIL_CODE_RE = /^[A-Z_]{3,40}$/
/**
 * A TURN THAT TRULY FAILED IS NEVER SILENT (2026-11-14). The page sends `fail` only for a turn that said nothing; the
 * edge then speaks ONE short true sentence for its code (the page's own words for the same case), or nothing for a
 * turn the owner cut himself (VOICE_TURN_CANCELLED). Any other code gets LOST_PLACE.
 */
export const FAIL_LINES = Object.freeze({
  VOICE_TURN_TIMEOUT: 'My thinking channel went quiet before the answer arrived. I reset it — say that once more.',
  VOICE_TURN_CEILING: 'That took longer than ten minutes, so I stopped it. Ask me again if you still want it.',
  VOICE_TURN_FAILED: 'The channel flickered — I lost my thread. Say it again?',
  VOICE_TURN_BUSY: 'I am still working on what you asked before. Ask me that again in a moment.',
  VOICE_LOOK_ONLY_REFUSED: 'My voice could not confirm it is look-only, so I did not send that.',
})
export const SILENT_FAIL_CODES = Object.freeze(['VOICE_TURN_CANCELLED'])
/**
 * WHY THE PAGE ENDED THE CALL (2026-11-14 review): `bye` may carry `why` from this closed list, and the call is recorded
 * with the end it names: the owner's Stop, the page's own duration timer (the call's deadline), the provider hanging up
 * (the SDK's disconnect), or anything else (a link or SDK error). A bare `bye` (a page from before this) is the Stop.
 */
export const BYE_ENDS = Object.freeze({ stop: 'owner-stop', timer: 'deadline', disconnected: 'provider-closed', error: 'error' })
/** the voice tools part 2: beside `why`, a `bye` may name `sdk`, the closed kind of the provider SDK's last error in the call
 * (voice-bridge.mjs VOICE_SDK_KINDS); the call's history row carries it. Anything outside the list is not a frame. */
const byeOk = frame => exactKeys(frame, ['t'])
  || (exactKeys(frame, ['t', 'why']) && typeof frame.why === 'string' && Object.hasOwn(BYE_ENDS, frame.why))
  || (exactKeys(frame, ['t', 'why', 'sdk']) && typeof frame.why === 'string' && Object.hasOwn(BYE_ENDS, frame.why)
    && typeof frame.sdk === 'string' && VOICE_SDK_KINDS.includes(frame.sdk))
/**
 * WHY A CALL OR A TURN ENDED (2026-11-14), for the owner's status read. Closed values and numbers only: never a
 * transcript, a conversation id or a turn id. The last 12 calls (4 until 2026-11-18) and the last 24 turns are kept.
 *   call `ended`: deadline | provider-closed | owner-stop (his Stop: a `bye` with why 'stop', or a bare `bye`)
 *     | unclaimed (no tab came for a provider that connected; or, since 2026-11-18, a minted start nobody claimed at
 *     all before its window passed: lastedSeconds 0) | journal-unavailable | error (a call the bridge lost track of: its
 *     slot ran out with no end recorded)
 *   turn `outcome`: answered | cancelled | failed | handed | refused, with a closed `reason`
 *     (voice-bridge.mjs VOICE_TURN_REASONS); a row stored before as done or late-answer reads answered, timeout reads failed
 */
export const HISTORY_KEY = 'voice-bridge:history'
/** The provider's saved voice settings as the owner door's last read carried them ({ at, settings }, closed
 * values only: voice-bridge.mjs readProviderSettings). */
export const PROVIDER_SEEN_KEY = 'voice-bridge:provider'
/**
 * HER AWARENESS SURVIVES BETWEEN CALLS. Each valid `aware` frame is also written
 * to this object's storage as { owner, frame, at }, at most once every AWARE_STORE_EVERY_MS per owner; a fast turn's first
 * call with no frame for its owner in memory loads it (its age is said honestly). On the first turn of a call, when the
 * tab said hello less than AWARE_FIRST_HELLO_MS ago and no frame has come in this call, the first model call waits up to
 * AWARE_FIRST_WAIT_MS for the first frame. The frame stays data inside the fence, never an instruction.
 */
export const AWARE_KEY = 'voice-bridge:aware'
export const AWARE_STORE_EVERY_MS = 30000
export const AWARE_FIRST_HELLO_MS = 2500
export const AWARE_FIRST_WAIT_MS = 1200
/** The stored frame holds her words and the crew relay: it is written only while the fast voice is on,
 * never used past this keep time (the spoken history's), and the bridge alarm deletes it then. */
export const AWARE_KEEP_MS = 1_800_000
/** The old spoken store (30 minutes, no chain): deleted when first seen, its words never converted. */
export const LEGACY_SPOKEN_KEY = 'voice-bridge:spoken'
/** the voice fix beside her voice memory: the digest a cut turn left for the next turn only ({ owner, digest }). */
export const MEMORY_DIGEST_KEY = 'voice-memory:digest'
/** The one exchange handed to her working self whose record waits for its `done` ({ owner, turnId, heard, said, atMs }):
 * the next fast prompt knows at once what he asked and that it was handed over. */
export const MEMORY_PENDING_KEY = 'voice-memory:pending'
/** What the status shows of her home ({ owner, gapFrom, adoptedFromHome, fork }): the first seq of the
 * last gap (or null), whether the edge's head was adopted from her home, and whether her home forked (sticky: nothing is
 * appended to her home again until a person decides). */
export const MEMORY_FLAGS_KEY = 'voice-memory:flags'
/** The digest of every record of her chain at the edge (64 hex each, never a word), so her home's
 * digest is checked below the tail too. `voice-memory:index` = { owner, epoch, from } names the chain (a new chain or a
 * head adopted from her home starts a new epoch; `from` is the first seq it covers); `voice-memory:index:<n>` =
 * { owner, epoch, digests: { "<seq>": hex } } holds MEMORY_INDEX_CHUNK seqs. A chunk of another epoch is never read. */
export const MEMORY_INDEX_KEY = 'voice-memory:index'
export const MEMORY_INDEX_CHUNK = 256
const indexChunkKey = seq => `${MEMORY_INDEX_KEY}:${String(Math.floor(seq / MEMORY_INDEX_CHUNK))}`
/** The closed codes of `memory_nack`. */
export const MEMORY_NACK_CODES = Object.freeze(['GAP', 'FORK', 'WRITE_FAILED'])
// voice-bridge.mjs VOICE_STATUS_CALLS (12 since 2026-11-18): every kept row can be shown.
export const CALLS_KEPT = 12
// The last 24 turns (the status contract).
export const TURNS_KEPT = 24
const wholeSeconds = ms => Math.max(0, Math.ceil(ms / 1000))

/**
 * A BACKCHANNEL NO LONGER CUTS HER OFF. A newer transcript that is ONLY a backchannel (this
 * closed list and its spellings, at most BACKCHANNEL_MAX_WORDS words) while her turn is live (being journaled, or
 * running) does not cancel it. The provider's documented upstream rule is that a newer `user_transcript` is the
 * interruption and that `agent_response` frames with an outdated `event_id` are silently discarded (scout-1113
 * VOICE-PROVIDER.md, from the provider's speech-engine-upstream page), so her turn is CARRIED OVER to the newest event
 * id: her remaining clauses, and its final, go out under it; its journal row and its tab turn id are unchanged. What the
 * provider did with audio already playing when he spoke is its own (UNVERIFIED): nothing already sent is sent again.
 * Anything else, or the same words with no live turn, is his turn as before.
 */
/**
 * WHAT HE SAYS WHILE SHE
 * WORKS is judged by one closed classifier, heardKind(text) -> 'keep' | 'presence' | 'stop' | 'words'. His words are
 * lower-cased, stripped of punctuation (an apostrophe or a hyphen inside a word stays), and the closed filler words are
 * dropped (her name as the recogniser hears it, and uh, um, hmm, please, so, well).
 *  - keep: one to HEARD_LIMITS.keepWords words left, every word or phrase on KEEP_PHRASES; or nothing left at all (he said
 *    only "um"). The live turn is carried to the newest event id (carryTurn).
 *  - presence: only her name, or exactly one of PRESENCE_PHRASES ("are you there").
 *  - stop: one to HEARD_LIMITS.stopPhrases phrases left, each on STOP_PHRASES, KEEP_PHRASES or "no", and at least one on
 *    STOP_PHRASES ("okay, stop", "no, wait", "hold on hold on hold on"). No keep phrase is ever on that list.
 *  - words: anything else. Words that hold a stop phrase anywhere ("stop it") are never merged into her turn
 *    (hasStopPhrase): they are a real interruption.
 */
export const HEARD_LIMITS = Object.freeze({ keepWords: 6, stopPhrases: 6 })
/** The keep list's word bound (the fast voice's name for it). */
export const BACKCHANNEL_MAX_WORDS = HEARD_LIMITS.keepWords
export const HEARD_NAMES = Object.freeze(['auma', 'omar', 'alma', 'oma'])
export const HEARD_FILLERS = Object.freeze([...HEARD_NAMES, 'uh', 'um', 'hmm', 'please', 'so', 'well'])
export const KEEP_PHRASES = Object.freeze(['mm-hm', 'mm-hmm', 'mmhm', 'mhm', 'uh-huh', 'yeah', 'ok', 'okay', 'right', 'mm hm', 'mm hmm', 'uh huh', 'got it',
  'yes', 'yep', 'yup', 'sure', 'alright', 'all right', 'fine', 'good', 'great', 'cool', 'nice', 'perfect', 'thanks', 'thank you', 'i see', 'continue',
  'go on', 'go ahead', 'keep going', 'carry on', 'proceed', 'take your time', 'no rush', 'listening', "i'm listening", 'im listening', 'i am listening',
  'sounds good'])
export const STOP_PHRASES = Object.freeze(['stop', 'wait', 'hold on', 'hang on', 'pause', 'cancel', 'never mind', 'nevermind', 'forget it', 'quiet',
  'be quiet', 'enough', "that's enough", 'thats enough', 'stop talking', 'one moment', 'one second', 'shut up'])
export const PRESENCE_PHRASES = Object.freeze(['are you there', 'you there', 'are you still there', 'still there', 'hello', 'hello hello',
  'can you hear me', 'do you hear me'])
/** the voice fix c: his words that only repeat a hand-off already running (after the fillers). */
export const HANDOFF_ECHO_PHRASES = Object.freeze(['hand it to your working self', 'hand to working self', 'hand it over', 'hand that to your working self',
  'yes hand it over', 'give it to your working self'])
/** His reactions while she talks (after the fillers): they ask nothing and tell her nothing new. Used ONLY to
 * decide that her cut words are picked up again (heardReaction); everywhere else these stay ordinary words. */
export const REACT_PHRASES = Object.freeze(['wow', 'oh wow', 'whoa', 'woah', 'oh', 'ooh', 'ah', 'aha', 'huh', 'mm', 'mmm', 'hm', 'ha', 'haha', 'lol',
  'oh my god', 'my god', 'oh my', 'omg', 'jesus', 'holy shit', 'holy fuck', 'oh shit', 'oh fuck', 'shit', 'fuck', 'fuck yeah', 'hell yeah', 'damn',
  'no way', 'amazing', 'awesome', 'incredible', 'beautiful', 'wonderful', 'brilliant', 'lovely', 'crazy', 'insane', 'wild', 'sick', 'exactly', 'totally',
  'true', 'interesting', 'love it', 'i love it', 'of course', 'for sure', 'makes sense', 'that makes sense', 'fair', 'fair enough', 'bro',
  'dude', 'man'])
const KEEP_SET = new Set(KEEP_PHRASES)
const REACT_SET = new Set([...KEEP_PHRASES, ...REACT_PHRASES])
const STOP_SET = new Set(STOP_PHRASES)
/** The phrases a stop may be said with (assent words and "no" around a stop phrase). */
const STOP_WITH_SET = new Set([...STOP_PHRASES, ...KEEP_PHRASES, 'no'])
const FILLER_SET = new Set(HEARD_FILLERS)
const NAME_SET = new Set(HEARD_NAMES)
/** His words as the classifier reads them: lower case, punctuation gone (an inner apostrophe or hyphen kept), spaces
 * collapsed. Fillers are still in. */
export function heardWords(text) {
  return plainWords(text)
    // "uh huh" is one keep word, never the filler "uh" and a stray "huh".
    .reduce((words, word) => { if (word === 'huh' && words.at(-1) === 'uh') words[words.length - 1] = 'uh-huh'; else words.push(word); return words }, [])
}
/** heardWords before "uh huh" is joined: one entry per word as written. What is finished with and what is
 * new are compared on these (a join across the cut would hide that an entry only grew). */
export function plainWords(text) {
  return String(text ?? '').toLowerCase().normalize('NFKC').replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/).map(word => word.replace(/^['-]+|['-]+$/g, '')).filter(Boolean)
}
/**
 * The ORIGINAL text of `text` after its first `count` words, counted as plainWords counts them: his own
 * spelling and punctuation, trimmed, from the next run that holds a word ('' when nothing follows). null when the cut
 * would fall inside a run with no space in it ("goodbye.Yeah"), or the text has fewer words: the caller then takes the
 * whole text.
 */
export function heardAfter(text, count) {
  const source = String(text ?? '')
  if (!Number.isSafeInteger(count) || count <= 0) return source.trim()
  const run = /\S+/g
  let seen = 0
  for (let match = run.exec(source); match !== null; match = run.exec(source)) {
    // Whether a word of this run was counted among the first `count` (a run with no word in it is skipped).
    let inside = false
    for (const _word of plainWords(match[0])) {
      if (seen === count) return inside ? null : source.slice(match.index).trim()
      seen++
      inside = true
    }
  }
  return seen === count ? '' : null
}
/** The phrases of `set` that `words` is made of (each one to three words long, longest first), or null when a word is
 * not on it. */
function phrasesOf(words, set) {
  const phrases = []
  for (let index = 0; index < words.length;) {
    const size = [3, 2, 1].find(length => index + length <= words.length && set.has(words.slice(index, index + length).join(' ')))
    if (!size) return null
    phrases.push(words.slice(index, index + size).join(' '))
    index += size
  }
  return phrases
}
const onlyPhrases = (words, set) => phrasesOf(words, set) !== null
export function heardKind(text) {
  const words = heardWords(text)
  // No word at all (an empty transcript) is never a keep; only fillers ("um") is.
  if (words.length === 0) return 'words'
  const left = words.filter(word => !FILLER_SET.has(word))
  if (left.length === 0) return words.some(word => NAME_SET.has(word)) ? 'presence' : 'keep'
  if (PRESENCE_PHRASES.includes(left.join(' '))) return 'presence'
  // A stop said with assent words or "no", or said again ("okay, stop", "wait wait wait"), is a stop.
  const stopped = phrasesOf(left, STOP_WITH_SET)
  if (stopped && stopped.length <= HEARD_LIMITS.stopPhrases && stopped.some(phrase => STOP_SET.has(phrase))) return 'stop'
  if (left.length <= HEARD_LIMITS.keepWords && onlyPhrases(left, KEEP_SET)) return 'keep'
  return 'words'
}
/** His words hold a stop phrase as a whole-word run anywhere ("stop it", "no wait, look at main"). */
export function hasStopPhrase(text) {
  const words = heardWords(text).filter(word => !FILLER_SET.has(word))
  return words.some((_, index) => [1, 2, 3].some(size => index + size <= words.length && STOP_SET.has(words.slice(index, index + size).join(' '))))
}
/** the fast voice's name, kept for its importers: only wait or assent words. */
export const isBackchannel = text => heardKind(text) === 'keep'
/** His words are only a reaction (REACT_PHRASES, with or without assent words), at most the keep list's word
 * bound, and hold no stop phrase. A question ("what?", "really?") is never one. */
export function heardReaction(text) {
  if (/[?？]/.test(String(text ?? ''))) return false
  const left = heardWords(text).filter(word => !FILLER_SET.has(word))
  return left.length > 0 && left.length <= HEARD_LIMITS.keepWords && onlyPhrases(left, REACT_SET) && !hasStopPhrase(text)
}
/** the voice fix c: his words only repeat the hand-off (after the fillers, and after leading assent words such as "okay"). */
export function handoffEcho(text) {
  const left = heardWords(text).filter(word => !FILLER_SET.has(word))
  while (left.length && KEEP_SET.has(left[0]) && !HANDOFF_ECHO_PHRASES.includes(left.join(' '))) left.shift()
  return HANDOFF_ECHO_PHRASES.includes(left.join(' '))
}
/** The words of `text` after the words of `before` when `text` starts with them (compared as the classifier reads them),
 * or null. The provider may send his unanswered utterances as one entry. */
export function heardExtension(before, text) {
  const head = heardWords(before)
  const all = heardWords(text)
  if (!head.length || all.length <= head.length || head.some((word, index) => all[index] !== word)) return null
  return all.slice(head.length).join(' ')
}
/** the voice fix a: his added words while a fast turn works, at most this many merges a turn, each cut to this. */
/** A model call's words count as an ANSWER to his words once more than this many were spoken, or once the
 * call ended with no tool call. A few words and then a look ("Let me look.") are never an answer, and an answer cut in
 * its first words leaves his words open (the next turn takes them whole). */
export const ANSWER_MIN_WORDS = 6
/**
 * SHE PICKS HER WORDS UP AFTER A CUT. The provider stops her
 * audio the moment it hears him, and throws away everything it had not spoken yet of the event it was answering. Her
 * model writes far faster than she speaks, so nearly always the rest of her answer had already been SENT and was lost:
 * one "yeah" from him and she went silent mid-sentence. When his words are only a wait or assent word, a reaction, or
 * "are you there", the bridge now sends the unspoken rest again under the new event id (resume, resumedTurn).
 *  - What was spoken: HER entry in the provider's own history when it is the reply to these words and lines up with what
 *    was sent (`history`), never more than she could have spoken in the time; otherwise the clock (`clock`), chunk by
 *    chunk from the time each went out (`unspoken`, `spokenByClock`). Near the end of her answer the clock does NOT
 *    pick up: his "yes" to a question she just asked is a turn of his own.
 *  - Where she starts: the first pick-up of a turn says the cut sentence again from its start when at most sentenceWords
 *    of it were spoken; a later one goes straight on from the cut (so a room that keeps cutting her still moves forward).
 *  - At most `max` pick-ups for one answer. Real words from him (anything else) are a real interruption, as before.
 */
export const RESUME = Object.freeze({ max: 3, heardMs: 700, leadMs: 500, wordsPerSecond: 2.4, fastLeadMs: 300, fastWordsPerSecond: 3.4,
  fastestWordsPerSecond: 4.5, clockMinWords: 5, historyMinWords: 3, sentenceWords: 14, compareWords: 400 })
/** `text` cut after its first `count` plain words: [before, after] in its own spelling and spacing. A cut that would fall
 * inside a run with no space puts the whole run after it (it is said again). */
export function splitAtWords(text, count) {
  const source = String(text ?? '')
  if (!Number.isSafeInteger(count) || count <= 0) return ['', source]
  const run = /\S+/g
  let seen = 0
  for (let match = run.exec(source); match !== null; match = run.exec(source)) {
    const size = plainWords(match[0]).length
    if (size === 0) continue
    if (seen + size > count) return [source.slice(0, match.index), source.slice(match.index)]
    seen += size
  }
  return [source, '']
}
/** How many of the words she was SENT (`sent`: plain words, in order) the provider's own entry of her (`agent`) shows as
 * spoken: the longest start of `sent` that her entry ends with (its last word may be cut short, and is then not counted).
 * A match is trusted when it is her whole entry or at least three words; null when nothing lines up. */
export function spokenByHistory(agent, sent) {
  const said = plainWords(agent).slice(-RESUME.compareWords)
  const words = sent.slice(0, RESUME.compareWords)
  for (let size = Math.min(said.length, words.length); size >= 1; size--) {
    const tail = said.slice(-size)
    if (!tail.every((word, index) => word === words[index] || (index === size - 1 && words[index].startsWith(word)))) continue
    if (size === said.length || size >= 3) return tail[size - 1] === words[size - 1] ? size : size - 1
  }
  return null
}
/**
 * How many words the provider can have spoken by `now`, on the clock alone. Each chunk is spoken after the one before it,
 * and never before it was sent plus `leadMs` (the time to start speaking after a silence): a pause in her words (a look,
 * a slow model) is silence, never speech. `sizes[i]` words went out at `ats[i]`.
 */
export function spokenByClock(sizes, ats, now, leadMs, wordsPerSecond) {
  let free = -Infinity, spoken = 0
  for (let index = 0; index < sizes.length; index++) {
    const begin = Math.max(free, ats[index] + leadMs)
    if (begin >= now) break
    const possible = Math.floor((now - begin) / 1000 * wordsPerSecond)
    if (possible < sizes[index]) return spoken + possible
    spoken += sizes[index]
    free = begin + sizes[index] / wordsPerSecond * 1000
  }
  return spoken
}
/**
 * The words of hers the provider had not spoken yet, to say again: `{ text, by, spoken, total }`, or null when there is
 * nothing to pick up. `chunks`, `kinds`, `ats`: what went out in the stretch that was cut, in order, with each chunk's
 * kind ('cue' chunks are never said again) and the time it was sent; `now`: when his words arrived.
 *  - `agent`: her entry in the provider's history, ONLY when it is the reply to the words this stretch answers (the
 *    caller decides). It is believed when it lines up with what was sent and holds no more than she could have spoken
 *    (fastestWordsPerSecond), and then a pick-up needs at least historyMinWords left.
 *  - Otherwise the clock (`clock` on), read at the moment his voice began (heardMs before his words arrived: the
 *    provider stopped her audio then). Two readings: the FAST one (fastLeadMs, fastWordsPerSecond) decides WHETHER to
 *    pick up, and only when it leaves at least clockMinWords unspoken: near the end of her answer the clock cannot tell
 *    a word that cut her from a reply to what she just said, and then his word must be a turn of his own. The CAREFUL
 *    one (leadMs, wordsPerSecond) decides WHERE she starts again, erring toward saying a little again.
 *  - Never the tail of her closing question: when all that is left is the end of a last sentence that asks him
 *    something, his word may be the answer to it, and it is a turn of his own (on either evidence).
 */
export function unspoken({ chunks, kinds, ats, now, agent, clock = true, again = false }) {
  const sizes = chunks.map(chunk => plainWords(chunk).length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (!total || !kinds.some(kind => kind !== 'cue')) return null
  const history = typeof agent === 'string' ? spokenByHistory(agent, chunks.flatMap(chunk => plainWords(chunk))) : null
  let spoken, by
  if (history !== null && history <= spokenByClock(sizes, ats, now, 0, RESUME.fastestWordsPerSecond) + 2) {
    if (total - history < RESUME.historyMinWords) return null
    spoken = history
    by = 'history'
  } else {
    if (!clock || total - spokenByClock(sizes, ats, now - RESUME.heardMs, RESUME.fastLeadMs, RESUME.fastWordsPerSecond) < RESUME.clockMinWords) return null
    spoken = spokenByClock(sizes, ats, now - RESUME.heardMs, RESUME.leadMs, RESUME.wordsPerSecond)
    by = 'clock'
  }
  if (spoken >= total) return null
  let before = '', after = '', left = spoken, cut = false
  chunks.forEach((chunk, index) => {
    const hers = kinds[index] !== 'cue'
    if (!cut && left >= sizes[index]) { left -= sizes[index]; if (hers) before += chunk; return }
    const [head, tail] = cut ? ['', chunk] : splitAtWords(chunk, left)
    cut = true
    if (hers) { before += head; after += tail }
  })
  if (!plainWords(after).length) return null
  // All that is left is the end of her last sentence, and it asks him something: his word may be the answer.
  if (/[?？]["'’”)\]]*\s*$/.test(after) && !/[.!?…？]["'’”)\]]*\s+\S/.test(after)) return null
  const ends = [...before.matchAll(/[.!?…]+["'’”)\]]*\s+/g)]
  const lead = before.slice(ends.length ? ends.at(-1).index + ends.at(-1)[0].length : 0)
  const leadWords = plainWords(lead).length
  const text = (!again && leadWords > 0 && leadWords <= RESUME.sentenceWords ? lead + after : after).trimStart()
  return { text, by, spoken, total }
}
export const MERGE_LIMITS = Object.freeze({ merges: 3, chars: 600, extendMs: 15000, extensions: 2 })
// The presence cue follows the turn's state (PRESENCE_CUES); "I'm here, still looking" only while she looks.
export const PRESENCE_CUE_EVERY_MS = 6000
export const HANDOFF_ECHO_CUE = cueWords('It is with my working self now')

/** The level a think_deeper call names, when it is one of THINK_LEVELS; otherwise null. */
function thinkLevel(call) {
  if (call.cut) return null
  try {
    const level = JSON.parse(call.args || '{}')?.level
    return THINK_LEVELS.includes(level) ? level : null
  } catch { return null }
}

const HEX_64 = /^[0-9a-f]{64}$/
const claudeWire = settings => settings.wire === 'anthropic'
/** The tool calls one turn's status keeps. */
const TOOL_LOG_MAX = 8
/** A fast call's failure code, as the status names it (voice-bridge.mjs VOICE_TURN_REASONS). */
const FAST_FAILURE_REASONS = Object.freeze({ VOICE_FAST_BUDGET: 'budget', VOICE_FAST_JOURNAL: 'journal', VOICE_FAST_REFUSED: 'provider_status',
  VOICE_FAST_UNREACHABLE: 'provider_status', VOICE_FAST_TOO_LARGE: 'provider_status', PROVIDER_REQUEST_SHAPE_UNSUPPORTED: 'request_shape',
  PROVIDER_BUDGET_REQUEST_INVALID: 'request_shape', PROVIDER_OUTPUT_LIMIT_REQUIRED: 'request_shape', VOICE_FAST_EFFORT_INVALID: 'request_shape' })
const TURN_MEMORY = 8
const LIVE = new Set(['journaling', 'running'])
const encoder = new TextEncoder()
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const exactKeys = (frame, keys) => Object.keys(frame).length === keys.length && keys.every(key => Object.hasOwn(frame, key))

async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** UTF-8 length of a string without copying it. */
export function utf8Bytes(text) {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code < 0xdc00 && index + 1 < text.length) { bytes += 4; index++ } else bytes += 3
  }
  return bytes
}

const memorySeq = value => Number.isSafeInteger(value) && value >= 0

/** One tab frame, closed shapes only (each at most 8 KiB of text; `aware` at most 32 KiB); null closes the socket. */
export function parseTabFrame(data) {
  const size = typeof data === 'string' ? encoder.encode(data).byteLength : Infinity
  if (size > AWARE_FRAME_MAX_BYTES) return null
  let frame
  try { frame = JSON.parse(data) } catch { return null }
  if (!isObject(frame) || (frame.t !== 'aware' && size > TAB_FRAME_MAX_BYTES)) return null
  const turnOk = value => typeof value === 'string' && BRIDGE_TURN_ID_RE.test(value)
  switch (frame.t) {
    case 'hello': return exactKeys(frame, ['t', 'conv']) && typeof frame.conv === 'string' && CONVERSATION_ID_RE.test(frame.conv) ? frame : null
    case 'delta': return exactKeys(frame, ['t', 'turn', 'seq', 'text']) && turnOk(frame.turn) && Number.isSafeInteger(frame.seq) && frame.seq >= 0
      && frame.seq <= EVENT_ID_MAX && typeof frame.text === 'string' && frame.text.length <= TAB_TEXT_MAX_CHARS ? frame : null
    case 'done': return exactKeys(frame, ['t', 'turn']) && turnOk(frame.turn) ? frame : null
    case 'fail': return exactKeys(frame, ['t', 'turn', 'code']) && turnOk(frame.turn) && typeof frame.code === 'string' && FAIL_CODE_RE.test(frame.code) ? frame : null
    case 'bye': return byeOk(frame) ? frame : null
    // Her page's awareness (voice-fast.mjs AWARE_LIMITS), read-only data for the fast voice.
    case 'aware': return validAwareFrame(frame) ? frame : null
    // The answer to one tool call the bridge sent (`tool`); its text is bounded again by the bridge.
    // Her home's head (once after ready), an acknowledged append, a refused one (with her home's head).
    case 'memory_have':
    case 'memory_ack': return exactKeys(frame, ['t', 'seq', 'digest']) && memorySeq(frame.seq) && typeof frame.digest === 'string' && HEX_64.test(frame.digest) ? frame : null
    case 'memory_nack': return exactKeys(frame, ['t', 'code', 'seq', 'digest']) && MEMORY_NACK_CODES.includes(frame.code) && memorySeq(frame.seq)
      && typeof frame.digest === 'string' && HEX_64.test(frame.digest) ? frame : null
    case 'tool_result': return exactKeys(frame, ['t', 'turn', 'call', 'ok', 'text']) && turnOk(frame.turn) && typeof frame.call === 'string'
      && TOOL_CALL_ID_RE.test(frame.call) && typeof frame.ok === 'boolean' && typeof frame.text === 'string' ? frame : null
    default: return null
  }
}

/** The inline-code state after `text`, from `state`: 0 outside a span, else the length of the backtick run that opened
 * it (a span closes only with a run of the same length, as Markdown reads it). */
export function spanAfter(text, state = 0) {
  for (const run of text.matchAll(/`+/g)) {
    if (state === 0) state = run[0].length
    else if (run[0].length === state) state = 0
  }
  return state
}

/** The end of the first clause in `text` that is NOT inside an inline code span (a sentence end followed by space, or a
 * line break; a blank line ends any span), from the span state `state`. { end: -1, state } when there is none yet. */
export function clauseEnd(text, state = 0) {
  let from = 0
  for (const match of text.matchAll(/[.!?…]+["'’”)]*\s+|\n+/g)) {
    state = spanAfter(text.slice(from, match.index), state)
    from = match.index
    if (state === 0 || /\n[^\S\n]*\n/.test(match[0])) return { end: match.index + match[0].length, state: 0 }
  }
  return { end: -1, state: spanAfter(text.slice(from), state) }
}

/** The end of the last early boundary (SOFT_BOUNDARY) in `text`, or -1. Only when ALL of `text` (the pending window,
 * which holds no sentence end) is plain prose (SOFT_UNSAFE matches none of it): a guarded shape that has begun to
 * arrive, anywhere in the window, keeps the whole clause together as before. */
export function softClauseEnd(text) {
  if (SOFT_UNSAFE.test(text)) return -1
  let end = -1
  for (const match of text.matchAll(SOFT_BOUNDARY)) if (text.slice(0, match.index).trim()) end = match.index + match[0].length
  return end
}

/** The next speakable clause of a turn's gathered text and how it was cut: at a clause end outside any code span
 * ('boundary'), with `soft` at an early boundary of plain prose once SOFT_CLAUSE_MIN_CHARS are pending ('soft'), at
 * the clause cap on a space ('space') or inside one long token ('token'), or the tail at `done` ('final'). An
 * unterminated `[field` tag at the tail waits for its `]`. Null: wait for more. */
export function cutClause(pending, final, soft = false) {
  const open = pending.search(/\[field\b[^\]]*$/)
  const usable = open === -1 ? pending : pending.slice(0, open)
  const window = usable.slice(0, VOICE_CLAUSE_MAX_CHARS)
  const { end } = clauseEnd(window)
  if (end !== -1) return { clause: usable.slice(0, end), rest: pending.slice(end), cut: 'boundary' }
  // A window that ends on a sentence mark already holds its whole sentence (its end is the next whitespace): no early cut.
  if (soft && !final && usable.length >= SOFT_CLAUSE_MIN_CHARS && !/[.!?…]+["'’”)]*$/.test(window)) {
    const early = softClauseEnd(window)
    if (early !== -1) return { clause: usable.slice(0, early), rest: pending.slice(early), cut: 'soft' }
  }
  if (usable.length >= VOICE_CLAUSE_MAX_CHARS) {
    const space = window.lastIndexOf(' ')
    if (space > 0) return { clause: usable.slice(0, space + 1), rest: pending.slice(space + 1), cut: 'space' }
    return { clause: window, rest: pending.slice(VOICE_CLAUSE_MAX_CHARS), cut: 'token' }
  }
  if (final) return pending ? { clause: usable, rest: '', cut: 'final' } : null
  return null
}

/** [clause, rest] or null to wait (cutClause without the cut). */
export function nextClause(pending, final) {
  const next = cutClause(pending, final)
  return next ? [next.clause, next.rest] : null
}

export const stripFieldTags = text => text.replace(/\[field\b[^\]]*\]/g, '')

/** The first block in her text that must be refused WHOLE, never judged line by line: a ``` fence, a `{`, or a `[` that
 * opens JSON (a line break, a bracket, a quote, a number or a literal follows it). `{ wait }` marks a tail that could
 * still become one (one or two backticks, a bare `[`) and is held for the next delta. */
export function findBlockOpener(text, final) {
  for (const match of text.matchAll(/```|\{|\[|`{1,2}$/g)) {
    if (match[0] === '```') return { index: match.index, kind: 'fence' }
    if (match[0] === '{') return { index: match.index, kind: 'nest' }
    const after = text.slice(match.index + match[0].length)
    if (match[0] === '[') {
      if (/^\s*(?:\n|[[{"]|-?\d|true\b|false\b|null\b)/.test(after)) return { index: match.index, kind: 'nest' }
      if (!final && /^\s*$/.test(after)) return { wait: match.index }
      continue
    }
    if (!final) return { wait: match.index }
  }
  return null
}

/** Scan an open `{`/`[` block (strings and escapes respected); the index just past its close, or -1 to keep waiting. */
export function scanNest(block, text) {
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (block.inString) {
      if (block.escape) block.escape = false
      else if (char === '\\') block.escape = true
      else if (char === '"') block.inString = false
    } else if (char === '"') block.inString = true
    else if (char === '{' || char === '[') block.depth++
    else if ((char === '}' || char === ']') && --block.depth === 0) return index + 1
  }
  return -1
}

export class VoiceBridgeDO {
  /** @param {object} state Durable Object state. @param {object} env Worker env (HEAD is the only binding used).
   * @param {object} [options] Tests only: `now`, `timers` ({ set, clear }). Cloudflare passes two arguments. */
  constructor(state, env, options = {}) {
    this.state = state
    this.env = env
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) }
    this.adapter = SPEECH_ENGINE_ADAPTER
    this.chain = Promise.resolve()
    this.convs = new Map()
    /** Every open socket this object holds, and those of them still waiting for `hello` or `init`. */
    this.peers = new Set()
    this.waiting = new Set()
    /** Terminal journal writes waiting for a retry. */
    this.writes = new Set()
    this.counts = {
      clausesDropped: 0, deltasDropped: 0, transcriptsRefused: 0, staleEvents: 0, providerErrors: 0, unjournaled: 0,
      pendingOverflows: 0, replyChunksDropped: 0, queueOverflows: 0, socketsRefused: 0, journalRetries: 0, journalWritesLost: 0,
      fastTurns: 0, fastFallbacks: 0, fastHandoffs: 0, awareFrames: 0, backchannelsKept: 0, handoffsKept: 0, awareStoredLoads: 0, awareWaits: 0, blocksTrimmed: 0,
      toolCalls: 0, toolRounds: 0, toolTimeouts: 0, toolResultsDropped: 0,
      // His words while she works (voice-bridge.md "What he says while she works").
      wordsMerged: 0, stops: 0, presenceCues: 0, handoffEchoes: 0,
      // Events that held nothing new from him, turns that took only the new words of a grown entry, and
      // events whose history ended with her entry.
      nothingNew: 0, grownTurns: 0, agentTailEvents: 0, resumes: 0, resumesByHistory: 0, resumeLimit: 0,
      // Her voice memory (voice-bridge.md "Her voice memory").
      memoryRecords: 0, memoryAcks: 0, memoryNacks: 0, memoryAdoptedFromHome: 0, memoryOtherOwner: 0,
      // 2026-11-18: whether the provider reaches the brain door at all, and what the page's tab does (voice-bridge.md
      // "When the voice does not start"). Each starts at 0 here: `++` on a missing count would make NaN.
      brainSockets: 0, brainInits: 0, brainFramesOther: 0, brainFramesRefused: 0, tabSockets: 0, tabHellos: 0, tabHellosRefused: 0, startsUnclaimed: 0,
    }
    /** The newest awareness frame from the owner's tab and when it arrived ({ owner, frame, at }), or null. */
    this.aware = null
    /** When each owner's frame was last written to storage (the write is throttled per owner). */
    this.awareStoredAt = new Map()
  }

  /** Terminal journal writes not yet confirmed (reported beside the counts). */
  get journalWritesPending() { return this.writes.size }

  /** Run one operation after every earlier one has settled; a failure never blocks the next. */
  serial(operation) {
    const run = this.chain.then(operation, operation)
    this.chain = run.catch(() => {})
    return run
  }

  async fetch(request) {
    if (new URL(request.url).pathname === NIGHTLY_PAGE_ROUTE) return nightlyPageResponse(request, this.state.storage, 'VOICE_BRIDGE')
    if (request.headers.get('x-x6-internal-authorized') !== '1') return reply({ ok: false, code: 'NOT_FOUND' }, 404)
    const path = new URL(request.url).pathname
    const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
    if (path === '/voice-bridge/admit' && request.method === 'POST') {
      let input = null
      try { input = await request.json() } catch { input = null }
      return reply(await this.serial(() => this.admit(input)))
    }
    if (path === '/voice-bridge/tab' && upgrade) return this.acceptTab(request.headers.get('x-x6-voice-owner'))
    if (path === '/voice-bridge/provider' && upgrade) return this.acceptProvider()
    return reply({ ok: false, code: 'NOT_FOUND' }, 404)
  }

  // ── Admission: one record, every change in one transaction, one at a time ───────────────────────────────────────
  /** `ending`: the conversation being ended now; its slot is left for endSlot to trim (its deadline is its `until`). */
  async readAdmission(tx, at, ending = null) {
    const stored = await tx.get(ADMISSION_KEY)
    const record = isObject(stored) ? stored : { day: '', daySeconds: 0, month: '', monthSeconds: 0, slots: {} }
    const periods = admissionPeriods(at)
    if (record.day !== periods.day) Object.assign(record, { day: periods.day, daySeconds: 0 })
    if (record.month !== periods.month) Object.assign(record, { month: periods.month, monthSeconds: 0 })
    let lapsed = false
    for (const [id, slot] of Object.entries(record.slots)) {
      if (slot.until > at || (ending !== null && slot.conv === ending)) continue
      delete record.slots[id]
      lapsed = true
      // A call that was claimed (hello) and ran out with no end recorded: the bridge lost track of it. Its seconds stay
      // spent (it may have run to the end). A minted call nobody claimed keeps its reservation as before.
      if (slot.conv !== null && Number.isSafeInteger(slot.helloAt)) {
        await this.pushHistory(tx, 'calls', { grantedSeconds: slot.seconds, ended: 'error', lastedSeconds: Math.min(slot.seconds, wholeSeconds(slot.until - slot.helloAt)), atMs: slot.until })
      } else if (slot.conv !== null) {
        // 2026-11-18: a start that was minted and bound but that no tab ever claimed (no hello) before its window passed:
        // one row, so the status shows the start happened at all. Its seconds stay spent as before. A slot only
        // reserved (no conversation bound) leaves nothing.
        await this.pushHistory(tx, 'calls', { grantedSeconds: slot.seconds, ended: 'unclaimed', lastedSeconds: 0, atMs: slot.until })
        this.counts.startsUnclaimed++
      }
    }
    // The deletions are written with the rows they produced, in this transaction, even when the caller then returns
    // without writing the record (a refused claim, an invalid admit): else the same lapsed slot would be found, and its
    // row pushed, again by the next transaction.
    if (lapsed) await tx.put(ADMISSION_KEY, record)
    return record
  }

  /**
   * A CALL THE EDGE LOST DOES NOT HOLD ITS SLOT. A claimed
   * call keeps its slot until it ends or its 20 minutes run out. When the edge restarts under a live call (every deploy
   * does; an eviction too) this object comes back holding no conversation, but the slot stayed in storage for up to 20
   * minutes: two such slots and every new start was refused VOICE_BUSY with nothing live. So when a new call is asked
   * for and the slots are full, every slot whose call a tab had claimed (helloAt) and that this object does not hold
   * (convs) is let go: its reservation is trimmed to the time since its hello, and the call history gets its row
   * (ended "error"). Only then is the start judged. A call this object holds is never touched (two real calls are
   * still two), nor is a slot still waiting for its mint or its tab (those lapse by their own short windows).
   */
  async releaseLostSlots(tx, record, at) {
    for (const [id, slot] of Object.entries(record.slots)) {
      if (slot.conv === null || !Number.isSafeInteger(slot.helloAt) || this.convs.has(slot.conv)) continue
      const used = Math.min(slot.seconds, Math.max(0, wholeSeconds(at - slot.helloAt)))
      if (slot.day === record.day) record.daySeconds = Math.max(0, record.daySeconds - (slot.seconds - used))
      if (slot.month === record.month) record.monthSeconds = Math.max(0, record.monthSeconds - (slot.seconds - used))
      delete record.slots[id]
      await this.pushHistory(tx, 'calls', { grantedSeconds: slot.seconds, ended: 'error', lastedSeconds: used, atMs: at })
    }
  }

  /** One entry onto the call or turn history (newest last, the oldest dropped over the bound), inside `tx`. */
  async pushHistory(tx, field, entry) {
    const stored = await tx.get(HISTORY_KEY)
    const history = { calls: [], turns: [] }
    if (isObject(stored)) for (const name of ['calls', 'turns']) if (Array.isArray(stored[name])) history[name] = stored[name]
    history[field] = [...history[field], entry].slice(-(field === 'calls' ? CALLS_KEPT : TURNS_KEPT))
    await tx.put(HISTORY_KEY, history)
  }

  async admit(input) {
    if (!isObject(input)) return { ok: false, code: 'VOICE_ADMIT_INVALID' }
    const at = Number.isSafeInteger(input.at) ? input.at : this.now()
    if (input.action === 'failure') return await this.noteFailure(input.door, input.stage, at)
    if (input.action === 'status') return await this.status(at)
    if (input.action === 'provider') {
      await this.state.storage.put(PROVIDER_SEEN_KEY, { at, settings: readProviderSettings(input.provider) })
      return { ok: true }
    }
    return await this.state.storage.transaction(async tx => {
      const record = await this.readAdmission(tx, at)
      const slot = typeof input.slot === 'string' ? record.slots[input.slot] : undefined
      let answer
      if (input.action === 'reserve') {
        // `seconds` is the most one call may want; what is reserved is that, or what is left of the day and the month.
        const most = validDurationSeconds(input.seconds)
        if (most === null) return { ok: false, code: 'VOICE_ADMIT_INVALID' }
        // Before a new call is refused as busy, the slots of calls this object lost are let go.
        if (Object.keys(record.slots).length >= VOICE_SESSION_LIMITS.liveConversations) await this.releaseLostSlots(tx, record, at)
        const seconds = Math.min(most, VOICE_SESSION_LIMITS.daySeconds - record.daySeconds, VOICE_SESSION_LIMITS.monthSeconds - record.monthSeconds)
        if (Object.keys(record.slots).length >= VOICE_SESSION_LIMITS.liveConversations) answer = { ok: false, code: 'VOICE_BUSY' }
        else if (seconds < VOICE_SESSION_LIMITS.minSeconds) answer = { ok: false, code: 'VOICE_QUOTA' }
        else {
          const id = `slot-${crypto.randomUUID()}`
          record.daySeconds += seconds
          record.monthSeconds += seconds
          record.slots[id] = { seconds, day: record.day, month: record.month, until: at + VOICE_MINT_WINDOW_MS, conv: null }
          answer = { ok: true, slot: id, seconds }
        }
      } else if (input.action === 'trim') {
        const seconds = validDurationSeconds(input.seconds)
        if (!slot || slot.conv !== null || seconds === null || seconds > slot.seconds) return { ok: false, code: 'VOICE_ADMIT_INVALID' }
        const less = slot.seconds - seconds
        if (slot.day === record.day) record.daySeconds -= less
        if (slot.month === record.month) record.monthSeconds -= less
        slot.seconds = seconds
        answer = { ok: true }
      } else if (input.action === 'release') {
        if (slot && slot.conv === null) delete record.slots[input.slot]
        answer = { ok: true }
      } else if (input.action === 'refund') {
        // Only an unbound slot (nothing was minted for it): its live slot AND its reserved seconds are given back.
        if (slot && slot.conv === null) {
          if (slot.day === record.day) record.daySeconds = Math.max(0, record.daySeconds - slot.seconds)
          if (slot.month === record.month) record.monthSeconds = Math.max(0, record.monthSeconds - slot.seconds)
          delete record.slots[input.slot]
        }
        answer = { ok: true }
      } else if (input.action === 'bind') {
        const conv = typeof input.conv === 'string' && CONVERSATION_ID_RE.test(input.conv) ? input.conv : null
        if (!slot || slot.conv !== null || conv === null || Object.values(record.slots).some(other => other.conv === conv)
          || typeof input.owner !== 'string' || !input.owner || !HEX_64.test(input.seedId ?? '')) return { ok: false, code: 'VOICE_ADMIT_INVALID' }
        Object.assign(slot, { conv, owner: input.owner, seedId: input.seedId, mintedAt: at, until: at + VOICE_CONNECT_WINDOW_MS,
          deadline: at + slot.seconds * 1000 + VOICE_CONNECT_GRACE_MS })
        answer = { ok: true }
      } else return { ok: false, code: 'VOICE_ADMIT_INVALID' }
      await tx.put(ADMISSION_KEY, record)
      return answer
    })
  }

  /** Record one closed stage for one door (anything outside the closed list is refused, never stored). */
  async noteFailure(door, stage, at) {
    if (!Object.hasOwn(VOICE_FAILURE_STAGES, door) || !VOICE_FAILURE_STAGES[door].includes(stage) || !Number.isSafeInteger(at)) return { ok: false, code: 'VOICE_ADMIT_INVALID' }
    return await this.state.storage.transaction(async tx => {
      const stored = await tx.get(FAILURES_KEY)
      const record = { lastFailure: null, owner: [], provider: [] }
      if (isObject(stored)) {
        for (const name of ['owner', 'provider']) if (Array.isArray(stored[name])) record[name] = stored[name].slice(-FAILURES_KEPT)
      }
      const list = record[door]
      if (list.at(-1)?.stage === stage) list.at(-1).atMs = at
      else list.push({ stage, atMs: at })
      record[door] = list.slice(-FAILURES_KEPT)
      record.lastFailure = { door, stage, atMs: at }
      await tx.put(FAILURES_KEY, record)
      return { ok: true }
    })
  }

  /** The owner's status read: conversations bound now, and every kept failure, newest first. Reads only. */
  async status(at) {
    const [admission, stored, history] = await Promise.all([this.state.storage.get(ADMISSION_KEY), this.state.storage.get(FAILURES_KEY), this.state.storage.get(HISTORY_KEY)])
    const slots = isObject(admission) && isObject(admission.slots) ? Object.values(admission.slots) : []
    const live = slots.filter(slot => isObject(slot) && slot.conv !== null && slot.until > at).length
    const failures = []
    if (isObject(stored)) {
      for (const door of ['owner', 'provider']) {
        if (Array.isArray(stored[door])) for (const item of stored[door].slice(-FAILURES_KEPT).reverse()) failures.push({ door, stage: item?.stage, atMs: item?.atMs })
      }
    }
    failures.sort((a, b) => b.atMs - a.atMs)
    // Seconds left: the ceilings less what is reserved or spent this UTC day and month (a live call counts in full).
    const periods = admissionPeriods(at)
    const usedDay = isObject(admission) && admission.day === periods.day && Number.isSafeInteger(admission.daySeconds) ? admission.daySeconds : 0
    const usedMonth = isObject(admission) && admission.month === periods.month && Number.isSafeInteger(admission.monthSeconds) ? admission.monthSeconds : 0
    const secondsLeft = { today: Math.max(0, VOICE_SESSION_LIMITS.daySeconds - usedDay), month: Math.max(0, VOICE_SESSION_LIMITS.monthSeconds - usedMonth) }
    const listed = name => (isObject(history) && Array.isArray(history[name]) ? history[name].slice(-(name === 'calls' ? CALLS_KEPT : TURNS_KEPT)).reverse() : [])
    // This object's counts (names from the closed list, whole numbers) and the key names of the last call's
    // stream block starts (E7). Never content.
    const counts = Object.fromEntries(VOICE_STATUS_COUNTS.map(name => [name, this.counts[name] ?? 0]))
    return { ok: true, live, failures, calls: listed('calls'), turns: listed('turns'), secondsLeft, counts, streamKeys: this.streamKeys ?? {}, memory: await this.memoryStatus(),
      provider: await this.providerSeen() }
  }

  /** The provider's saved settings last read, or null. */
  async providerSeen() {
    const stored = await this.state.storage.get(PROVIDER_SEEN_KEY).catch(() => undefined)
    return isObject(stored) && Number.isSafeInteger(stored.at) ? { readAtMs: stored.at, settings: readProviderSettings(stored.settings) } : null
  }

  /** Her voice memory as the status shows it: the head's seq and the first 12 hex of its digest, what her
   * home acknowledged and what it has not, the last gap, whether the head was adopted from her home, whether it forked.
   * Numbers, hex and booleans only: never a word, a salt or a whole digest. */
  async memoryStatus() {
    const [head, synced, flags] = await Promise.all([MEMORY_KEYS.head, MEMORY_KEYS.synced, MEMORY_FLAGS_KEY].map(key => this.state.storage.get(key).catch(() => undefined)))
    const owned = isObject(head) && Number.isSafeInteger(head.seq) && typeof head.digest === 'string' && HEX_64.test(head.digest) ? head : null
    const flagged = isObject(flags) && owned && flags.owner === owned.owner ? flags : {}
    const seq = owned?.seq ?? 0
    const acked = Number.isSafeInteger(synced) && owned ? Math.min(synced, seq) : 0
    return { seq, digest12: (owned?.digest ?? ZERO_DIGEST).slice(0, 12), synced: acked, unsynced: seq - acked,
      gapFrom: Number.isSafeInteger(flagged.gapFrom) ? flagged.gapFrom : null, adoptedFromHome: flagged.adoptedFromHome === true, fork: flagged.fork === true }
  }

  /** The live slot bound to `conv`, or null. `claim` (a tab's hello) extends it to its deadline. */
  async slotFor(conv, claim = null) {
    const at = this.now()
    return await this.state.storage.transaction(async tx => {
      const record = await this.readAdmission(tx, at)
      const entry = Object.entries(record.slots).find(([, slot]) => slot.conv === conv)
      if (!entry) { await tx.put(ADMISSION_KEY, record); return null }
      const [, slot] = entry
      if (claim !== null) {
        if (slot.owner !== claim || !(slot.deadline > at)) return null
        slot.until = Math.min(slot.deadline, (slot.helloAt ?? at) + slot.seconds * 1000)
        slot.helloAt ??= at
      }
      await tx.put(ADMISSION_KEY, record)
      return { ...slot }
    })
  }

  /**
   * The call is over: its live slot goes, and its RESERVATION IS TRIMMED to what it used (from the mint to now, rounded
   * up, never more than it reserved); the rest goes back to the day and the month it was taken from. Every end path
   * comes here (deadline, provider-closed, owner-stop, unclaimed, journal-unavailable). The call is recorded.
   */
  async endSlot(conv, ended, sdk = undefined) {
    const at = this.now()
    await this.state.storage.transaction(async tx => {
      const record = await this.readAdmission(tx, at, conv)
      for (const [id, slot] of Object.entries(record.slots)) {
        if (slot.conv !== conv) continue
        const startedAt = Number.isSafeInteger(slot.mintedAt) ? slot.mintedAt : at
        const used = Math.min(slot.seconds, wholeSeconds(at - startedAt))
        const back = slot.seconds - used
        if (slot.day === record.day) record.daySeconds = Math.max(0, record.daySeconds - back)
        if (slot.month === record.month) record.monthSeconds = Math.max(0, record.monthSeconds - back)
        delete record.slots[id]
        await this.pushHistory(tx, 'calls', { grantedSeconds: slot.seconds, ended, lastedSeconds: Math.min(slot.seconds, wholeSeconds(at - (slot.helloAt ?? startedAt))), atMs: at,
          ...(VOICE_SDK_KINDS.includes(sdk) ? { sdk } : {}) })
      }
      await tx.put(ADMISSION_KEY, record)
    })
  }

  /** One finished turn of hers onto the history: its outcome, seconds to her first words, its longest quiet, and
   * (2026-11-16) its timings in whole milliseconds from the transcript's arrival (voice-bridge.mjs VOICE_TURN_TIMINGS;
   * every one a difference of this object's own clock, null when not observed) and the cue said (VOICE_TURN_CUES). */
  async noteTurn(turn, how) {
    if (turn.noted) return
    turn.noted = true
    const at = this.now()
    const quiet = Math.max(turn.longestQuietMs ?? 0, at - (turn.lastAt ?? turn.arrivedAt))
    const since = mark => (Number.isSafeInteger(mark) ? Math.max(0, mark - turn.arrivedAt) : null)
    // Why the turn ended, in closed codes (voice-bridge.mjs VOICE_TURN_OUTCOMES, VOICE_TURN_REASONS).
    const outcome = turn.fast?.refused ? 'refused' : how === 'done' ? (turn.fast?.handoff || turn.path === 'fast_fell_back' ? 'handed' : 'answered') : how === 'cancelled' ? 'cancelled' : 'failed'
    const reason = turn.fast?.refused ? 'model_refusal' : turn.endReason ?? (how === 'cancelled' ? 'barge_in' : how === 'timeout' ? 'turn_bound' : null)
    const entry = {
      outcome,
      reason,
      journalMs: since(turn.journaledAt),
      endMs: Math.max(0, at - turn.arrivedAt),
      calls: turn.fast?.callNo ?? 0,
      merged: turn.merged ?? 0,
      // 1 when this turn's words were only the new part of an entry that grew.
      grown: turn.grown ? 1 : 0,
      // How many times her cut words were picked up again in this turn.
      resumed: turn.resumes ?? 0,
      cues: turn.cues ?? 0,
      toolRounds: (turn.toolLog ?? []).map(item => ({ ...item })),
      firstWordsSeconds: Number.isSafeInteger(turn.firstWordsAt) ? wholeSeconds(turn.firstWordsAt - turn.arrivedAt) : null,
      longestQuietSeconds: wholeSeconds(quiet),
      journaledMs: since(turn.journaledAt),
      handedMs: since(turn.handedAt),
      firstTextMs: since(turn.firstTextAt),
      firstSpeechMs: since(turn.firstWordsAt),
      // Which path answered (voice-bridge.mjs VOICE_TURN_PATHS) and the fast model's first text.
      modelFirstMs: since(turn.modelFirstAt),
      cue: turn.cue ?? 'none',
      path: turn.path ?? 'governed',
      // A turn the fast voice took (or tried) carries its provider NAME and model id; a governed one none.
      ...(typeof turn.fastProvider === 'string' ? { provider: turn.fastProvider, model: turn.fastModel } : {}),
      // The level the turn ran at and who chose it; a level he asked for that the edge does not offer.
      ...(typeof turn.effort === 'string' ? { effort: turn.effort, effortBy: turn.effortBy } : {}),
      ...(typeof turn.effortNotOffered === 'string' ? { effortNotOffered: turn.effortNotOffered } : {}),
      atMs: at,
    }
    await this.state.storage.transaction(tx => this.pushHistory(tx, 'turns', entry)).catch(() => null)
  }

  // ── Sockets ──────────────────────────────────────────────────────────────────────────────────────────────────────
  socketPair() {
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()
    return { client, server }
  }

  /** A new socket: tracked and waiting for its first frame, unless eight already wait (then it is closed at once). */
  open(socket, frameMax) {
    const peer = { socket, frameMax, conv: null, closed: false, queued: 0, waitTimer: undefined }
    if (this.waiting.size >= BRIDGE_LIMITS.waitingSockets) {
      this.counts.socketsRefused++
      peer.closed = true
      try { socket.close(1013) } catch { /* already closed */ }
      return null
    }
    this.peers.add(peer)
    this.waiting.add(peer)
    return peer
  }

  untrack(peer) {
    this.peers.delete(peer)
    this.waiting.delete(peer)
  }

  /** Each frame is measured as it ARRIVES (its time stamped then): one larger than the socket's frame cap, or one that
   * would put more than 64 KiB behind the frame in hand, closes the socket before anything else is done with it.
   * `onRefused` (optional, 2026-11-18) runs after `onGone` for such a frame: the provider door counts and records it as
   * it does a frame parse could not read, since the socket is closed over a frame either way. */
  listen(peer, onMessage, onGone, onRefused) {
    peer.socket.addEventListener('message', event => {
      if (peer.closed) return
      const data = event.data
      const size = typeof data === 'string' ? utf8Bytes(data) : (Number.isSafeInteger(data?.byteLength) ? data.byteLength : 0)
      if (size > peer.frameMax || (peer.queued > 0 && peer.queued + size > BRIDGE_LIMITS.queuedBytes)) {
        if (size <= peer.frameMax) this.counts.queueOverflows++
        this.close(peer, 1008)
        void this.serial(async () => {
          await onGone(peer)
          if (onRefused) await onRefused(peer)
        })
        return
      }
      peer.queued += size
      const arrivedAt = this.now()
      void this.serial(async () => { peer.queued -= size; await onMessage(peer, data, arrivedAt) })
    })
    const gone = () => { this.untrack(peer); void this.serial(() => onGone(peer)) }
    peer.socket.addEventListener('close', gone)
    peer.socket.addEventListener('error', gone)
  }

  close(peer, code = 1000) {
    if (!peer || peer.closed) return
    peer.closed = true
    this.untrack(peer)
    if (peer.waitTimer !== undefined) { this.timers.clear(peer.waitTimer); peer.waitTimer = undefined }
    try { peer.socket.close(code) } catch { /* already closed */ }
  }

  send(peer, text) {
    if (!peer || peer.closed) return false
    try { peer.socket.send(text); return true } catch { return false }
  }

  toTab(record, frame) { return this.send(record.tab, JSON.stringify(frame)) }

  acceptTab(owner) {
    const { client, server } = this.socketPair()
    // The socket's own cap is the largest frame it may carry (`aware`); parseTabFrame holds every other frame to 8 KiB.
    const tab = this.open(server, AWARE_FRAME_MAX_BYTES)
    if (tab) {
      this.counts.tabSockets++
      tab.owner = typeof owner === 'string' ? owner : ''
      tab.waitTimer = this.timers.set(() => { void this.serial(async () => { if (tab.conv === null) this.close(tab, 1008) }) }, HELLO_WAIT_MS)
      this.listen(tab, (peer, data) => this.onTab(peer, data), peer => this.tabGone(peer))
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  acceptProvider() {
    const { client, server } = this.socketPair()
    const provider = this.open(server, PROVIDER_FRAME_MAX_BYTES)
    if (provider) {
      // 2026-11-18: the provider reached the brain door past the Worker's checks (its JWT and the bridge secret).
      this.counts.brainSockets++
      provider.waitTimer = this.timers.set(() => { void this.serial(async () => {
        if (provider.conv !== null || provider.closed) return
        this.close(provider, 1008)
        await this.noteFailure('provider', 'init-timeout', this.now()).catch(() => null)
      }) }, INIT_WAIT_MS)
      this.listen(provider, (peer, data, arrivedAt) => this.onProvider(peer, data, arrivedAt), peer => this.providerGone(peer),
        () => this.providerFrameRefused())
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  /** 2026-11-18: a provider frame closed the brain socket, whether listen() refused it as it arrived (larger than the
   * socket's cap, or too much already queued behind the frame in hand) or parse could not read it. Counted, and recorded
   * as the provider stage 'frame-refused' (best effort), after the socket is closed and the call let go as before. */
  async providerFrameRefused() {
    this.counts.brainFramesRefused++
    await this.noteFailure('provider', 'frame-refused', this.now()).catch(() => null)
  }

  record(conv, slot) {
    let record = this.convs.get(conv)
    if (!record) {
      record = { conv, seedId: slot.seedId, seconds: slot.seconds, owner: typeof slot.owner === 'string' ? slot.owner : '', tab: null, provider: null,
        turns: new Map(), current: null, ended: false, deadlineTimer: undefined, claimTimer: undefined }
      this.convs.set(conv, record)
    }
    return record
  }

  /** The conversation (not a socket) waits at most PROVIDER_HOLD_MS for an owner tab; then it is ended and removed. */
  awaitTab(record) {
    if (record.ended || record.tab || record.claimTimer !== undefined) return
    record.claimTimer = this.timers.set(() => { void this.serial(async () => {
      record.claimTimer = undefined
      if (!record.ended && !record.tab) await this.endConversation(record, 'unclaimed')
    }) }, PROVIDER_HOLD_MS)
  }

  // ── The tab door ─────────────────────────────────────────────────────────────────────────────────────────────────
  async onTab(tab, data) {
    if (tab.closed) return
    const frame = parseTabFrame(data)
    if (!frame || (tab.conv === null) !== (frame.t === 'hello')) return await this.rejectTab(tab)
    if (frame.t === 'hello') return await this.hello(tab, frame.conv)
    const record = this.convs.get(tab.conv)
    if (!record || record.tab !== tab) return this.close(tab, 1008)
    if (frame.t === 'bye') return await this.endConversation(record, null, frame.why === undefined ? 'owner-stop' : BYE_ENDS[frame.why], frame.sdk)
    if (frame.t === 'aware') {
      // Kept as data with its arrival time; it changes nothing else (no turn, no state, no rule).
      this.aware = { owner: tab.owner, frame, at: this.now() }
      this.counts.awareFrames++
      // A first model call waiting for this call's first frame goes on now.
      for (const wake of record.awareWaiters?.splice(0) ?? []) wake()
      const stored = this.awareStoredAt.get(tab.owner)
      if (tab.owner && fastVoiceSettings(this.env).on && (stored === undefined || this.aware.at - stored >= AWARE_STORE_EVERY_MS)) {
        this.awareStoredAt.set(tab.owner, this.aware.at)
        await this.state.storage.put(AWARE_KEY, this.aware).catch(() => null)
        await this.armSweep()
      }
      return
    }
    // Her home's word about her voice memory (never a turn).
    if (frame.t === 'memory_have' || frame.t === 'memory_ack' || frame.t === 'memory_nack') return await this.memoryFrame(record, frame)
    // A tool result is taken only for a call still pending on a live fast turn (a late one is dropped).
    if (frame.t === 'tool_result') return this.toolResult(record, frame)
    const turn = [...record.turns.values()].find(item => item.turnId === frame.turn)
    // Only a turn handed to the tab takes the tab's words (a fast turn the tab never got takes none).
    if (!turn || turn.state !== 'running' || turn.handedAt === undefined) { this.counts.deltasDropped++; return }
    if (frame.t === 'delta') {
      if (frame.seq !== turn.seq) return await this.rejectTab(tab)
      turn.seq++
      // A handed turn a newer turn has passed (quiet): its words are dropped unsaid; its work goes on.
      if (turn.quiet) { this.counts.deltasDropped++; return }
      // Review 2026-11-16: her working self has begun its answer: from here no presence or handed cue goes between her words.
      if (frame.text) turn.tabWordsAt ??= this.now()
      this.gather(turn, frame.text, true)
      return this.flush(record, turn, false)
    }
    if (frame.t === 'done') {
      this.flush(record, turn, true)
      return await this.finish(record, turn, 'done')
    }
    // `fail`: the page said nothing for this turn. Abandoned; one true sentence for its code (none for the owner's cut).
    await this.finish(record, turn, 'fail', frame.code)
  }

  /** Her text for a turn (the tab's delta, or the fast model's): timed, gathered, bounded. `timed`: the turn is
   * released (its first text and its quiet are measured from here). */
  gather(turn, text, timed) {
    if (timed) {
      const at = this.now()
      turn.longestQuietMs = Math.max(turn.longestQuietMs ?? 0, at - (turn.lastAt ?? turn.arrivedAt))
      turn.lastAt = at
      if (text) turn.firstTextAt ??= at
    }
    turn.pending += text
    if (turn.pending.length * 3 > BRIDGE_LIMITS.pendingBytes && utf8Bytes(turn.pending) > BRIDGE_LIMITS.pendingBytes) {
      // Over the bound: everything gathered is dropped, and so is the rest of the clause it was in.
      turn.pending = ''
      this.counts.clausesDropped++
      this.counts.pendingOverflows++
      if (!turn.block) turn.discard = { state: 0 }
    }
  }

  async hello(tab, conv) {
    const slot = await this.slotFor(conv, tab.owner)
    if (!slot || tab.closed) {
      if (!slot && !tab.closed) this.counts.tabHellosRefused++
      return this.close(tab, 1008)
    }
    this.counts.tabHellos++
    if (tab.waitTimer !== undefined) { this.timers.clear(tab.waitTimer); tab.waitTimer = undefined }
    this.waiting.delete(tab)
    const record = this.record(conv, slot)
    // When this call's tab first said hello (the call's age in her facts).
    record.helloAt ??= Number.isSafeInteger(slot.helloAt) ? slot.helloAt : this.now()
    const older = record.tab
    record.tab = tab
    tab.conv = conv
    if (older && older !== tab) {
      older.replaced = true
      this.close(older, 1000)
      await this.tabLost(record)
    }
    if (record.claimTimer !== undefined) { this.timers.clear(record.claimTimer); record.claimTimer = undefined }
    if (record.deadlineTimer === undefined) {
      record.deadlineTimer = this.timers.set(() => { void this.serial(() => this.endConversation(record, 'deadline')) }, Math.max(0, slot.until - this.now()))
    }
    this.toTab(record, { t: 'ready', conv, maxDurationSeconds: slot.seconds })
    // A transcript that arrived before this hello is the first turn now.
    await this.advance(record)
  }

  /** A frame outside the closed shapes: the socket is closed, and a turn it was running is closed honestly. */
  async rejectTab(tab) {
    this.close(tab, 1008)
    await this.tabGone(tab)
  }

  async tabGone(tab) {
    tab.closed = true
    this.untrack(tab)
    if (tab.waitTimer !== undefined) { this.timers.clear(tab.waitTimer); tab.waitTimer = undefined }
    const record = tab.conv === null ? null : this.convs.get(tab.conv)
    if (!record || record.tab !== tab || tab.replaced) return
    record.tab = null
    await this.tabLost(record)
  }

  /** Her tab is gone: a journaled running turn is closed honestly (the fixed sentence if nothing was said yet), and the
   * conversation waits for a tab again. */
  async tabLost(record) {
    const turn = record.turns.get(record.current)
    if (turn && LIVE.has(turn.state)) await this.finish(record, turn, 'lost')
    for (const item of new Set(record.turns.values())) if (item.quiet && LIVE.has(item.state)) await this.finish(record, item, 'lost')
    this.awaitTab(record)
  }

  // ── The provider door ────────────────────────────────────────────────────────────────────────────────────────────
  async onProvider(provider, data, arrivedAt) {
    if (provider.closed) return
    const event = this.adapter.parse(data)
    if (!event) {
      this.close(provider, 1008)
      await this.providerGone(provider)
      // 2026-11-18: counted and recorded after the socket is closed and the call let go exactly as before.
      return await this.providerFrameRefused()
    }
    if (event.kind === 'init') return await this.init(provider, event.conv)
    if (event.kind === 'ping') return void this.send(provider, this.adapter.pong(event.eventId))
    if (event.kind === 'error') { this.counts.providerErrors++; return }
    // 2026-11-18: a frame of a type the adapter does not know (or a transcript with no event id) is counted and ignored,
    // before or after init: it never closes the call, and it is not an init (the init wait still runs).
    if (event.kind === 'other') { this.counts.brainFramesOther++; return }
    if (provider.conv === null) return this.close(provider, 1008)
    const record = this.convs.get(provider.conv)
    if (!record || record.provider !== provider) return this.close(provider, 1008)
    if (event.kind === 'close') { this.close(provider, 1000); return await this.providerLost(record) }
    // The history's shape (whose entry is last, how many are his) goes with his words.
    await this.transcript(record, event.eventId, event.text, arrivedAt, { tail: event.tail, users: event.users, agent: event.agent, agentAfter: event.agentAfter })
  }

  async init(provider, conv) {
    if (provider.conv !== null) return this.close(provider, 1008)
    const slot = await this.slotFor(conv)
    if (!slot || provider.closed) {
      // An init for a conversation no owner minted (or whose slot lapsed): recorded, then the socket is closed.
      if (!slot) await this.noteFailure('provider', 'init-unbound', this.now()).catch(() => null)
      return this.close(provider, 1008)
    }
    if (provider.waitTimer !== undefined) { this.timers.clear(provider.waitTimer); provider.waitTimer = undefined }
    this.waiting.delete(provider)
    const record = this.record(conv, slot)
    const older = record.provider
    record.provider = provider
    provider.conv = conv
    this.counts.brainInits++
    if (older && older !== provider) { older.replaced = true; this.close(older, 1000) }
    // No tab has said hello yet: the CONVERSATION waits (a replaced provider socket inherits the same wait).
    this.awaitTab(record)
  }

  async providerGone(provider) {
    provider.closed = true
    this.untrack(provider)
    if (provider.waitTimer !== undefined) { this.timers.clear(provider.waitTimer); provider.waitTimer = undefined }
    const record = provider.conv === null ? null : this.convs.get(provider.conv)
    if (!record || record.provider !== provider || provider.replaced) return
    await this.providerLost(record)
  }

  async providerLost(record) {
    record.provider = null
    await this.endConversation(record, 'provider-closed')
  }

  /** The provider heard event N. A newer N interrupts the older turn FIRST; then N's text is judged; a usable one waits
   * for an announced tab and for any unconfirmed cancel, and only then is journaled and handed over. */
  async transcript(record, eventId, text, arrivedAt, shape = {}) {
    if (record.ended) return
    if (record.current !== null && eventId < record.current) { this.counts.staleEvents++; return }
    if (record.current === eventId) return this.replay(record, eventId)
    const older = record.turns.get(record.current)
    // the voice fix A/B: `text` is his WHOLE last entry (the adapter bounds it at 32,000); `users` is how many entries of
    // the history are his, `shape.tail` whose entry is last. An adapter that says neither changes nothing here.
    const users = Number.isSafeInteger(shape.users) ? shape.users : undefined
    if (shape.tail === 'agent') this.counts.agentTailEvents++
    // His words she has spoken an answer to are finished with (`answered`: the entry her answer covered,
    // set in say()). A turn that said nothing of hers, or only a line before a look, leaves them open: they stay in the
    // next turn's words. Words he added that her answer has not read yet are never counted as answered.
    if (older?.answered) record.dealt = { words: plainWords(older.answered.text), users: older.answered.users }
    if (older && LIVE.has(older.state) && text) {
      // What he said while her turn is live. The same words again are a keep; words that only extend the
      // running turn's words are judged by what follows.
      // Compared with the turn's WHOLE entry (`full`), never with the new words it was started on.
      const known = [older.lastHeard, older.full ?? older.transcript].filter(item => typeof item === 'string')
      const same = known.some(item => heardWords(item).join(' ') === heardWords(text).join(' '))
      const base = same ? undefined : known.find(item => heardExtension(item, text) !== null)
      const extension = base === undefined ? null : heardExtension(base, text)
      const added = extension ?? text
      // The same added words in HIS spelling (a question mark tells a question from a reaction).
      const addedText = base === undefined ? text : heardAfter(text, plainWords(base).length) ?? text
      // Words over the bound of one turn are never kept, merged or judged here (they end below, refused).
      const kind = same ? 'keep' : added.length > PROVIDER_TRANSCRIPT_MAX_CHARS ? 'long' : heardKind(added)
      const fast = older.fast
      const fastWorking = older.path === 'fast' && fast?.status === 'running' && !fast.handoff && older.handedAt === undefined
      const handed = Boolean(fast?.handoff) && older.handedAt !== undefined
      // Is she TALKING (her words are going out), or working quietly after a line such as "Let me look."?
      // Only words she was saying are picked up again; a preface before a look is never said twice.
      // A turn handed to her working self that has only said its hand-off line is not talking either.
      const talking = !(fastWorking && !fast.answering) && !(handed && older.tabWordsAt === undefined)
      // A reaction ("wow", "oh my god", never a question) while she talks is carried as a keep is.
      if (kind === 'keep' || (kind === 'words' && talking && older.said && !handed && heardReaction(addedText))) {
        // What the provider had not spoken yet under the id his voice just cut (the same words again cut nothing: only
        // the provider's own history may say so then). Read BEFORE the carry moves the turn to the new id.
        const cut = talking ? this.unspokenOf(older, shape, arrivedAt, !same) : null
        this.carryTurn(record, older, eventId, arrivedAt, text, users)
        this.settleCarried(older)
        this.counts.backchannelsKept++
        this.resume(record, older, cut, !same)
        return
      }
      if (kind === 'presence') {
        const cut = talking ? this.unspokenOf(older, shape, arrivedAt) : null
        this.carryTurn(record, older, eventId, arrivedAt, text, users)
        this.settleCarried(older)
        // She was talking: her words go on (that answers "are you there").
        if (this.resume(record, older, cut)) return
        // And on a turn handed to her working self ("I'm here; my working self is on it").
        if (older.state === 'running' && ((fastWorking && !fast.answering) || (handed && !older.quiet && older.tabWordsAt === undefined))) this.presenceCue(record, older)
        return
      }
      if (kind === 'stop') {
        // His stop: her speech and the fast turn stop as a barge-in does (a handed turn only goes quiet, its work goes
        // on); the new event gets the empty final, and no model turn starts for it.
        this.counts.stops++
        record.current = eventId
        if (handed) this.quietHanded(older)
        else {
          older.endReason = 'stop_words'
          await this.cancelTurn(record, older, 'superseded', 'barge_in')
        }
        // His stop finishes everything he said before it.
        record.dealt = { words: plainWords(text), users }
        this.stoppedTurn(record, eventId, text, arrivedAt, 'stopped', users)
        return
      }
      // Words that hold a stop phrase ("stop it") are never merged: she stays interruptible.
      if (kind === 'words' && fastWorking && !fast.answering && (fast.added?.length ?? 0) < MERGE_LIMITS.merges && !hasStopPhrase(added)) {
        this.carryTurn(record, older, eventId, arrivedAt, text, users)
        this.mergeWords(record, older, added)
        return
      }
      if (kind === 'words' && handed && handoffEcho(added)) {
        // His words only repeat the hand-off already running: carried, one cue, and no second prompt to the tab.
        this.carryTurn(record, older, eventId, arrivedAt, text, users)
        this.settleCarried(older)
        this.counts.handoffEchoes++
        if (older.state === 'running' && !older.quiet) this.say(record, older, HANDOFF_ECHO_CUE, 'cue', 'early')
        return
      }
    }
    // ONLY WHAT IS NEW IS ANSWERED. The provider sends his whole last entry each time, and that entry grows
    // while his words are unanswered; a frame may also come when he said nothing new. `fresh`: his words of this entry
    // that are not finished with.
    const news = this.newWords(record, text, users, shape.tail)
    if (news.nothing && older?.state !== 'held') {
      // Nothing new from him (the history ends with her entry, after words already finished with): no model turn starts.
      this.counts.nothingNew++
      if (older && LIVE.has(older.state)) {
        // He said nothing, so nothing cut her: only the provider's own history may say words were dropped.
        const cut = this.unspokenOf(older, shape, arrivedAt, false)
        this.carryTurn(record, older, eventId, arrivedAt, text, users)
        this.settleCarried(older)
        this.resume(record, older, cut, false)
        return
      }
      record.current = eventId
      // Her last answer is finished here; this id has discarded whatever the provider had not spoken of it.
      // He said nothing, so the clock is not asked: only her own entry may show that words were dropped (a sound that
      // cut her audio and left no words of his). Otherwise the event is closed empty, and it remembers which answer
      // came before it, so a later "yeah" still finds her words.
      const spoke = this.spokenTurn(older)
      const cut = spoke ? this.unspokenOf(spoke, shape, arrivedAt, false) : null
      if (cut) this.resumedTurn(record, eventId, text, arrivedAt, users, spoke, cut)
      else this.stoppedTurn(record, eventId, text, arrivedAt, 'unchanged', users, spoke)
      return
    }
    // A turn still waiting to start holds his unanswered words: the same entry again starts on those words.
    let fresh = news.nothing ? older.transcript : news.fresh
    const grown = news.nothing ? Boolean(older.grown) : news.grown
    // The 4,000 bound is for the words of ONE turn (over it: refused below, as an over-long transcript was).
    if (fresh.length > PROVIDER_TRANSCRIPT_MAX_CHARS) fresh = ''
    if (fresh && heardKind(fresh) === 'stop') {
      // His stop with no live turn (her last reply may still be playing at the provider, or a turn just
      // stopped): the empty final, and no model turn starts for it. A turn still waiting to start is let go.
      this.counts.stops++
      record.current = eventId
      if (older?.state === 'held') older.state = 'superseded'
      record.dealt = { words: plainWords(text), users }
      this.stoppedTurn(record, eventId, text, arrivedAt, 'stopped', users)
      return
    }
    // Her last answer is finished HERE but may still be playing THERE. A wait or assent word, a reaction or
    // "are you there" that cut its audio starts no model turn: the rest of it is said again under this id.
    // A keep word said as a question ("right?") is his question, and so is anything the clock cannot tell from a reply.
    const freshKind = fresh ? heardKind(fresh) : 'words'
    const spoke = this.spokenTurn(older)
    if (fresh && spoke && (freshKind === 'presence' || (freshKind === 'keep' && !/[?？]/.test(fresh)) || heardReaction(fresh))) {
      const cut = this.unspokenOf(spoke, shape, arrivedAt)
      if (cut) {
        record.current = eventId
        record.dealt = { words: plainWords(text), users }
        this.resumedTurn(record, eventId, text, arrivedAt, users, spoke, cut)
        return
      }
    }
    record.current = eventId
    if (older?.state === 'held') older.state = 'superseded'
    else if (older && LIVE.has(older.state) && older.fast?.handoff && older.handedAt !== undefined) {
      // Her fast voice handed this to her working self: his next words do not cut that work. It goes quiet (its later
      // words are dropped unsaid, no cancel goes to the tab) and its own done or fail closes its row.
      this.quietHanded(older)
    } else if (older && LIVE.has(older.state)) {
      older.endReason ??= 'barge_in'
      await this.cancelTurn(record, older, 'superseded', 'barge_in')
    }
    // `transcript` is what this turn answers (his new words); `full` his whole entry, `users` its place.
    // `read`: the entry (and its place) whose words the model has read or that need no answer; `answered`: the entry her
    // spoken answer covered, once she has spoken one (say()).
    const turn = { eventId, turnId: `eleven:${record.conv}:${eventId}`, transcript: fresh, full: text, users, startUsers: users, grown, read: { text, users }, answered: undefined,
      arrivedAt, state: 'held', seq: 0, pending: '',
      block: null, blockTail: false, discard: null, sent: [], sentTotal: 0, replayFrom: 0, sentTruncated: false, spoken: false, backchannelTimer: undefined,
      earlyCueTimer: undefined, cue: 'none', path: null, said: '', fast: null }
    record.turns.set(eventId, turn)
    // The oldest are forgotten, never a quiet handed turn still running (its done must still find it).
    this.forgetTurns(record)
    if (record.ended) return
    if (!fresh) {
      // Empty, whitespace or over the limit: it still superseded the older turn; it gets the empty final only.
      turn.state = 'refused'
      this.counts.transcriptsRefused++
      this.send(record.provider, this.adapter.final(eventId))
      return
    }
    await this.advance(record)
  }

  /** Her live turn is carried over to this event id (the backchannel rule of the fast voice), never cancelled:
   * her remaining clauses and its final go out under it; its journal row and tab turn id are unchanged. */
  carryTurn(record, older, eventId, arrivedAt, text, users = older.users) {
    record.current = eventId
    older.eventId = eventId
    older.lastHeard = text
    // And the place of that entry among his (a keep said as a new entry moves it).
    older.users = users
    record.turns.set(eventId, older)
    // A provider retry of this id replays only what goes out under it, never what was said under the older id.
    older.replayFrom = older.sentTotal
    // The provider's wait starts again for this id: the timeout cue counts from this arrival and may be said once more
    // (the early cue stays once per turn).
    older.cueFrom = arrivedAt
    older.carriedQuiet = true
    if (older.cue === 'timeout') older.cue = 'early'
    // armCues clears every cue timer of the turn first: a carried turn keeps exactly one live timer set.
    if (older.state === 'running') this.armCues(record, older)
  }

  /** A handed turn his newer words passed: it goes quiet (its later words are dropped unsaid, no cancel goes to the tab)
   * and its own done or fail closes its row. */
  quietHanded(older) {
    this.clearBackchannel(older)
    older.quiet = true
    Object.assign(older, { pending: '', block: null, blockTail: false, discard: null })
    this.counts.handoffsKept++
  }

  /**
   * What of his entry `text` is new, against the words finished with (`record.dealt`: plain words and the
   * entry's place among his). The rules apply only to the SAME entry (the places equal, or one of them not known).
   * `nothing`: the history ends with HER entry (the provider itself holds her reply after his words) and his last entry
   * is exactly the words finished with. The same entry again with HIS entry last is never "nothing": the provider holds
   * no reply of hers after it (it may have dropped one he did not hear to the end), so it is answered, as before.
   * `grown`: the entry only grew past the words finished with, and `fresh` is his own text after them (a cut that is not
   * clean takes the whole entry). Otherwise `fresh` is the whole entry, as before.
   */
  newWords(record, text, users, tail) {
    const whole = { nothing: false, fresh: text, grown: false }
    const words = plainWords(text)
    const dealt = record.dealt ?? null
    if (!text || !words.length || !dealt || !dealt.words.length) return whole
    if (!(users === undefined || dealt.users === undefined || users === dealt.users)) return whole
    if (dealt.words.length > words.length || dealt.words.some((word, index) => words[index] !== word)) return whole
    if (dealt.words.length === words.length) return tail === 'agent' ? { nothing: true, fresh: '', grown: false } : whole
    const fresh = heardAfter(text, dealt.words.length)
    return fresh && plainWords(fresh).join(' ') === words.slice(dealt.words.length).join(' ') ? { nothing: false, fresh, grown: true } : whole
  }

  /** A carried keep, presence or echo needs no answer: with no added words of his still unread, the entry it
   * came in is read, and finished with at once when her answer already covered everything read before it. */
  settleCarried(turn) {
    if (turn.fast?.addedPending.length || turn.fast?.readNext) return
    // Review: `answered` moves with it only when her answer already covered everything read so far (the same object):
    // never past words a call in flight has read and not yet answered.
    const was = turn.read
    turn.read = { text: turn.lastHeard, users: turn.users }
    if (turn.answered && turn.answered === was) turn.answered = turn.read
  }

  /** His whole entry as this turn began, then what he added while she worked: the words the spoken-search
   * rule may find a query in (the turn's own words may be only the new part of an entry that grew). */
  heardWhole(turn) {
    return [turn.full ?? turn.transcript, ...(turn.fast?.added ?? [])].join(' / ')
  }

  /** The event of his stop words: kept (a retry of it is answered), the empty final, and no model turn.
   * Also the event that held nothing new from him (state `unchanged`). */
  stoppedTurn(record, eventId, text, arrivedAt, state = 'stopped', users = undefined, prior = null) {
    const turn = { eventId, turnId: `eleven:${record.conv}:${eventId}`, transcript: text, full: text, users, read: { text, users }, answered: undefined, arrivedAt, state, seq: 0, pending: '',
      block: null, blockTail: false, discard: null, sent: [], sentTotal: 0, replayFrom: 0, sentTruncated: false, spoken: false, backchannelTimer: undefined,
      earlyCueTimer: undefined, cue: 'none', path: null, said: '', fast: null, prior }
    record.turns.set(eventId, turn)
    this.forgetTurns(record)
    this.send(record.provider, this.adapter.final(eventId))
  }

  /** The turn whose words may still be playing at the provider when `older` is the current one: a finished
   * answer or an earlier pick-up; behind an event that was closed empty because he said nothing new, the answer that
   * came before it (`prior`). Never behind his stop, a refusal or a cancelled turn. */
  spokenTurn(older) {
    const turn = older?.state === 'unchanged' ? older.prior : older
    return turn && (turn.state === 'done' || turn.state === 'resumed') ? turn : null
  }

  /** What the provider had not spoken yet of this turn's words (`unspoken`, over the stretch from `cutFrom`),
   * or null. `shape`: the adapter's reading of this frame's history. `clock` off: only her own entry may say so. */
  unspokenOf(turn, shape, arrivedAt, clock = true) {
    const count = Math.min(turn.sentTotal - (turn.cutFrom ?? turn.sentTotal), turn.sent.length)
    const kinds = (turn.sentKinds ?? []).slice(-count)
    if (!(count > 0) || kinds.length !== count) return null
    // Her entry counts only when it comes AFTER the words this turn answers: an older reply (it may even be the same
    // words, "say that again") says nothing about this one.
    const hers = Number.isSafeInteger(shape.agentAfter) && Number.isSafeInteger(turn.startUsers) && shape.agentAfter >= turn.startUsers ? shape.agent : undefined
    const found = unspoken({ chunks: turn.sent.slice(-count), kinds, ats: turn.sentAts.slice(-count), now: arrivedAt, agent: hers, clock, again: (turn.resumes ?? 0) > 0 })
    if (found && (turn.resumes ?? 0) >= RESUME.max) { this.counts.resumeLimit++; return null }
    return found
  }

  /** Her live turn says the unspoken rest again under the id it was just carried to. True when it did.
   * `voiceCut`: his voice cut her audio, so whatever went out before is spoken or gone: with nothing to pick up, the
   * stretch starts afresh at her next words. Without it (the same entry again) the stretch is kept: a later frame with
   * her own entry in it may still show that words were dropped. */
  resume(record, turn, cut, voiceCut = true) {
    if (!cut && voiceCut) turn.cutFrom = turn.sentTotal
    if (!cut || record.ended || turn.state !== 'running' || turn.quiet) return false
    turn.resumes = (turn.resumes ?? 0) + 1
    this.counts.resumes++
    if (cut.by === 'history') this.counts.resumesByHistory++
    this.say(record, turn, cut.text, 'resume')
    return true
  }

  /** The rest of an answer that was finished here and cut there, as its own closed event: the words, then the
   * final. No model turn, no journal row, no memory record (nothing new was said). A retry of the id replays it, and a
   * further cut picks up from it. */
  resumedTurn(record, eventId, text, arrivedAt, users, prior, cut) {
    const turn = { eventId, turnId: `eleven:${record.conv}:${eventId}`, transcript: text, full: text, users, read: { text, users }, answered: undefined, arrivedAt, state: 'resumed', seq: 0, pending: '',
      block: null, blockTail: false, discard: null, sent: [cut.text], sentKinds: ['resume'], sentTotal: 1, replayFrom: 0, sentTruncated: false, spoken: true, backchannelTimer: undefined,
      earlyCueTimer: undefined, cue: 'none', path: null, said: '', fast: null, resumes: (prior.resumes ?? 0) + 1, cutFrom: 0, sentAts: [this.now()], startUsers: users }
    record.turns.set(eventId, turn)
    this.forgetTurns(record)
    this.counts.resumes++
    if (cut.by === 'history') this.counts.resumesByHistory++
    this.send(record.provider, this.adapter.chunk(eventId, cut.text))
    this.send(record.provider, this.adapter.final(eventId))
  }

  /** The oldest turns are forgotten, never a quiet handed turn still running (its done must still find it). */
  forgetTurns(record) {
    let excess = record.turns.size - TURN_MEMORY
    for (const [key, item] of [...record.turns]) {
      if (excess <= 0) break
      if (item.quiet && LIVE.has(item.state)) continue
      record.turns.delete(key)
      excess--
    }
  }

  /** the voice fix 3: he asked whether she is there while her fast turn works and has not begun its answer: one cue, at
   * most once every PRESENCE_CUE_EVERY_MS in a call. */
  presenceCue(record, turn) {
    // "I'm here" and what she is doing now (a deep turn: what its fast call is doing); never over a clause of
    // hers that is pending, never when no state fits.
    const state = cueState(turn)
    const cue = PRESENCE_CUES[state === 'deep' ? workState(turn) : state]
    if (cue === undefined || turn.pending.trim() || turn.block) return
    const at = this.now()
    if (record.presenceCueAt !== undefined && at - record.presenceCueAt < PRESENCE_CUE_EVERY_MS) return
    record.presenceCueAt = at
    this.counts.presenceCues++
    this.say(record, turn, cue, 'cue', 'early')
  }

  /**
   * the voice fix 5a: his words while her fast turn works and has not begun its answer are MERGED into it (the turn was
   * carried first). They reach the model at the next boundary (runTools, fastAnswerEnded), never by aborting the call in
   * flight. They are his words: they count for the spoken-search rule and the effort phrases as his transcript does, and
   * they join the kept exchange's `heard`. Each merge extends the whole-turn bound once, at most MERGE_LIMITS.extensions.
   */
  mergeWords(record, turn, added) {
    const fast = turn.fast
    const words = String(added).trim().slice(0, MERGE_LIMITS.chars)
    fast.added.push(words)
    fast.addedPending.push(words)
    turn.merged = (turn.merged ?? 0) + 1
    this.counts.wordsMerged++
    if (fast.extensions < MERGE_LIMITS.extensions && fast.deadline !== undefined && Number.isSafeInteger(fast.deadlineAt)) {
      fast.extensions++
      fast.deadlineAt += MERGE_LIMITS.extendMs
      this.timers.clear(fast.deadline)
      fast.deadline = this.timers.set(() => { fast.deadline = undefined; void this.serial(() => this.fastFail(record, turn, 'turn_bound')) }, Math.max(0, fast.deadlineAt - this.now()))
    }
    // His effort phrases, read from his added words exactly as from his transcript (voice-fast.mjs ownerEffort).
    if (fast.wire === 'anthropic') {
      const asked = ownerEffort(words)
      if (asked.hold === null) record.effortHold = null
      else if (asked.hold !== undefined && fast.offered.includes(asked.hold)) record.effortHold = asked.hold
      if (asked.level && fast.offered.includes(asked.level) && asked.level !== fast.effort) {
        fast.effort = asked.level
        Object.assign(turn, { effort: asked.level, effortBy: 'owner', deep: isDeepEffort(asked.level) })
      }
    }
  }

  /** His words of this turn: what he said, then what he added while she worked. */
  heardOf(turn) {
    return [turn.transcript, ...(turn.fast?.added ?? [])].join(' / ')
  }

  /** The provider retried the newest event: a turn still waiting or running is re-attached (nothing new starts); a
   * finished one is replayed from its kept chunks, or answered with the empty final when they are not all kept. */
  replay(record, eventId) {
    const turn = record.turns.get(eventId)
    if (!turn || turn.state === 'held' || LIVE.has(turn.state)) return
    // Only what went out under THIS id (a carried turn's earlier clauses went out under an older one), and only when
    // all of it is kept.
    const count = turn.sentTotal - turn.replayFrom
    if ((turn.state === 'done' || turn.state === 'abandoned' || turn.state === 'resumed') && count > 0 && count <= turn.sent.length) {
      this.send(record.provider, this.adapter.chunk(eventId, turn.sent.slice(-count).join('')))
    }
    this.send(record.provider, this.adapter.final(eventId))
  }

  /** Start the newest held turn when it may start: a tab has said hello and no cancel of an older turn is unconfirmed.
   * Journal first; an unconfirmed journal write runs nothing and says nothing. */
  async advance(record) {
    const turn = record.turns.get(record.current)
    if (record.ended || !turn || turn.state !== 'held') return
    if (!record.tab) { this.awaitTab(record); return }
    if ([...this.writes].some(write => write.conv === record.conv && write.payload.action === 'cancel')) return
    turn.state = 'journaling'
    // The turns of this call so far (her facts say how many came before this one).
    record.turnsStarted = (record.turnsStarted ?? 0) + 1
    // D6: the fast call starts with the journal write; nothing it writes is released until the write is confirmed.
    this.startFast(record, turn)
    const journaled = await this.journal(record.seedId, { turnId: turn.turnId, provider: 'eleven-managed-voice', endpoint: '/door/voice-brain',
      requestedModel: null, ...await this.envelope(turn), modality: 'voice', voiceId: null })
    if (turn.state !== 'journaling') return
    if (journaled.ok !== true) {
      // Unconfirmed: the fast call is aborted and whatever it wrote is dropped unsaid.
      this.stopFast(turn)
      turn.pending = ''
      turn.state = 'unjournaled'
      this.counts.unjournaled++
      turn.endReason ??= 'journal'
      await this.noteTurn(turn, 'failed')
      this.send(record.provider, this.adapter.final(turn.eventId))
      this.toTab(record, { t: 'cancel', turn: turn.turnId, reason: 'unjournaled' })
      return
    }
    turn.journaledAt = this.now()
    turn.state = 'running'
    // Counted when the turn runs (never a waiting turn a newer event replaced, nor one never journaled).
    if (turn.grown) this.counts.grownTurns++
    if (!record.tab) return await this.finish(record, turn, 'lost')
    if (turn.path === 'fast') {
      // The journal is confirmed: what the fast model already wrote is released now, and the rest as it comes.
      this.armCues(record, turn)
      // An answer that ended in a refusal releases nothing it wrote (fastEnded says the one line).
      if (turn.pending && !turn.fast.refused) { this.gather(turn, '', true); turn.firstTextAt ??= this.now(); this.flush(record, turn, false) }
      // Tool calls that waited for this confirmation may go to the tab now.
      this.wakeFast(turn)
      if (turn.fast.status === 'ended') await this.fastEnded(record, turn)
      return
    }
    await this.handToTab(record, turn)
  }

  /** The governed hand-off: the turn goes to her tab (her session in the voice thread), and the cues are set. */
  async handToTab(record, turn) {
    if (!record.tab) return await this.finish(record, turn, 'lost')
    // the voice tools V5: a fast hand-off that named one of her conversations (a title her own awareness listed) carries it.
    // the effort levels commit 2: her own hand_to_session, and his own words asked for the council (voice-fast.mjs councilAsked):
    // the closed marker `kind: "council"` tells the page to frame her governed prompt for a consult. Never from the
    // awareness or her words, never on a fallback or a governed-only turn (review 2026-11-16).
    // His words added while the fast turn worked are his words of this turn: they go to her working self
    // with what he said first (joined " / ", within the tab's text bound), and they count for the council as his
    // transcript does. Never her words, never the awareness.
    const heard = this.heardOf(turn).slice(0, TAB_TEXT_MAX_CHARS)
    this.toTab(record, { t: 'turn', turn: turn.turnId, eventId: turn.eventId, transcript: heard,
      ...(typeof turn.handTo === 'string' ? { conversation: turn.handTo } : {}), ...(turn.fast?.handoff && councilAsked(heard) ? { kind: 'council' } : {}) })
    turn.handedAt = this.now()
    // Review 2026-11-16: a deep turn's governed part gets the normal cues, its wait counted from the last thing he heard
    // (a "still thinking" is no timeout cue of the governed turn).
    if (turn.deep) { turn.cueFrom = turn.lastSentAt ?? turn.cueFrom; if (turn.cue === 'timeout') turn.cue = 'early' }
    this.armCues(record, turn)
  }

  /** The two cues of a running turn, (re)set from what is left of their deadlines. Setting them again is harmless: each
   * cue is said at most once (its own state check). */
  armCues(record, turn) {
    this.clearBackchannel(turn)
    // A deep turn's start cue, or her think_deeper's cue, once; then the keep-alive instead of the two cues.
    if (turn.thinkCue && !turn.thinkCueSaid && turn.state === 'running' && !turn.quiet && !record.ended && turn.path === 'fast') {
      turn.thinkCueSaid = true
      if (turn.thinkCue === THINK_CUE || !turn.spoken) this.say(record, turn, turn.thinkCue, 'cue', 'early')
    }
    // Review 2026-11-16: only while the fast call runs; a handed-off or fallen-back deep turn gets the normal cues.
    // Not while only the follow-up call after her whole answer runs (she is not working then).
    const working = turn.path === 'fast' && turn.fast?.status === 'running' && !turn.fast.answered
    if (turn.deep && working) return this.keepAlive(record, turn)
    // She has spoken and her fast turn still works: the work cue (one timer, never beside the two cues).
    if (turn.spoken && working) return this.armWorkCue(record, turn)
    // She has spoken and handed the turn to her working self: "my working self is on it", once, after
    // WORK_CUE_AFTER_MS with nothing heard. A carried turn instead gets the provider-wait cue below (in the same words).
    if (turn.spoken && !turn.carriedQuiet && cueState(turn) === 'handed' && unusedCue(turn, 'handed')) this.armHandedCue(record, turn)
    // Both cues' deadlines count from the transcript's ARRIVAL; what is left is computed now, after the waits. The early
    // cue is set only while the timeout cue is still ahead (after a long wait, only the timeout cue is left, never both).
    const wait = (turn.cueFrom ?? turn.arrivedAt) + SPEECH_ENGINE_TIMEOUT_SECONDS * 1000 - BACKCHANNEL_LEAD_MS - this.now()
    const early = turn.arrivedAt + EARLY_CUE_MS - this.now()
    if (earlyCueOn(this.env) && wait > 0 && early < wait) {
      if (early <= 0) this.earlyCue(record, turn)
      else turn.earlyCueTimer = this.timers.set(() => { turn.earlyCueTimer = undefined; this.earlyCue(record, turn) }, early)
    }
    if (wait <= 0) this.backchannel(record, turn)
    else turn.backchannelTimer = this.timers.set(() => { turn.backchannelTimer = undefined; this.backchannel(record, turn) }, wait)
  }

  /** The next keep-alive of a deep turn, DEEP_CUE_EVERY_MS after the last thing he heard (review 2026-11-16). */
  keepAlive(record, turn) {
    const due = (turn.lastSentAt ?? turn.arrivedAt) + DEEP_CUE_EVERY_MS - this.now()
    turn.backchannelTimer = this.timers.set(() => { turn.backchannelTimer = undefined; this.stillThinking(record, turn) }, Math.max(0, due))
  }

  /** The keep-alive of a deep turn whose fast call runs: one line, then the next due. Her words before it
   * do not stop it (review 2026-11-16): the cadence counts from the last chunk sent. */
  stillThinking(record, turn) {
    if (turn.state !== 'running' || turn.quiet || record.ended || turn.path !== 'fast' || turn.fast?.status !== 'running' || turn.fast.answered) return
    this.say(record, turn, STILL_THINKING_CUE, 'cue', 'timeout')
    this.armCues(record, turn)
  }

  /** The next work cue, WORK_CUE_AFTER_MS after the last thing he heard and WORK_CUE_EVERY_MS after the
   * last work cue; none past WORK_CUE_MAX. */
  armWorkCue(record, turn, least = 0) {
    const fast = turn.fast
    this.clearBackchannel(turn)
    if (fast.workCues >= WORK_CUE_MAX || fast.answered) return
    const due = Math.max((turn.lastSentAt ?? turn.arrivedAt) + WORK_CUE_AFTER_MS, (fast.workCueAt ?? -Infinity) + WORK_CUE_EVERY_MS) - this.now()
    turn.backchannelTimer = this.timers.set(() => { turn.backchannelTimer = undefined; this.workCue(record, turn) }, Math.max(least, due))
  }

  /** One work cue, if her fast turn still works and nothing of hers is flowing or pending. */
  workCue(record, turn) {
    const fast = turn.fast
    if (turn.state !== 'running' || turn.quiet || record.ended || turn.path !== 'fast' || fast?.status !== 'running' || fast.workCues >= WORK_CUE_MAX || fast.answered) return
    // A clause of hers is pending: looked at again shortly (never a cue over her words).
    if (turn.pending.trim() || turn.block || this.now() - (turn.lastSentAt ?? turn.arrivedAt) < WORK_CUE_AFTER_MS) return this.armWorkCue(record, turn, WORK_CUE_RECHECK_MS)
    // The next unused words of what she is doing NOW. Used up: nothing is said for this state (looked at again
    // shortly: the state may change), unless the provider's per-event wait would lapse, when the provider-wait words go.
    const cue = unusedCue(turn, cueState(turn)) ?? (this.now() - (turn.lastSentAt ?? turn.arrivedAt) >= SPEECH_ENGINE_TIMEOUT_SECONDS * 1000 - BACKCHANNEL_LEAD_MS ? BACKCHANNEL : null)
    if (cue === null) return this.armWorkCue(record, turn, WORK_CUE_RECHECK_MS)
    this.say(record, turn, cue, 'cue', 'timeout')
    fast.workCues++
    fast.workCueAt = this.now()
    this.armWorkCue(record, turn)
  }

  /** The one handed cue of a turn she handed to her working self after speaking, WORK_CUE_AFTER_MS after the
   * last thing he heard. */
  armHandedCue(record, turn, least = 0) {
    if (turn.handedCueTimer !== undefined) this.timers.clear(turn.handedCueTimer)
    const due = (turn.lastSentAt ?? turn.arrivedAt) + WORK_CUE_AFTER_MS - this.now()
    turn.handedCueTimer = this.timers.set(() => { turn.handedCueTimer = undefined; this.handedCue(record, turn) }, Math.max(least, due))
  }

  /** "my working self is on it", once a turn, while the handed turn runs and nothing of hers is pending. */
  handedCue(record, turn) {
    if (turn.state !== 'running' || turn.quiet || record.ended || turn.carriedQuiet || cueState(turn) !== 'handed' || turn.tabWordsAt !== undefined) return
    const cue = unusedCue(turn, 'handed')
    if (cue === null) return
    if (turn.pending.trim() || turn.block || this.now() - (turn.lastSentAt ?? turn.arrivedAt) < WORK_CUE_AFTER_MS) return this.armHandedCue(record, turn, WORK_CUE_RECHECK_MS)
    this.say(record, turn, cue, 'cue', 'timeout')
  }

  /** The early acknowledgement, once, for a running turn that has said nothing yet. Runs on its own clock (it only
   * reads the turn's state and sends one frame). "hmm" when his words are a question, "mm-hm" otherwise; a
   * governed-only turn keeps "mm-hm". */
  earlyCue(record, turn) {
    if (turn.state === 'running' && !turn.spoken && turn.cue === 'none' && !record.ended) {
      const cue = turn.path === 'governed' ? EARLY_CUE : heardQuestion(turn.transcript) ? FIRST_CUES.question : FIRST_CUES.statement
      this.say(record, turn, cue, 'cue', 'early')
    }
  }

  /** The timeout-protection cue, once, for a running turn that has said no words (the early cue may come before it).
   * Runs on its own clock, not behind other work: it only reads the turn's state and sends one frame. Its
   * timing and once-per-carried-event rule are unchanged; its words are the next unused words of the turn's state, or
   * "one sec" (used up, no state, a deep or a governed-only turn). */
  backchannel(record, turn) {
    // A turn carried to a newer event id that has said nothing under it yet counts as quiet for that id's wait.
    if (turn.state === 'running' && (!turn.spoken || turn.carriedQuiet) && !turn.quiet && turn.cue !== 'timeout' && !record.ended) {
      this.say(record, turn, unusedCue(turn, cueState(turn)) ?? BACKCHANNEL, 'cue', 'timeout')
    }
  }

  /** Both cue timers of a turn go (her words, its end, a cut). */
  clearBackchannel(turn) {
    if (turn.backchannelTimer !== undefined) { this.timers.clear(turn.backchannelTimer); turn.backchannelTimer = undefined }
    if (turn.earlyCueTimer !== undefined) { this.timers.clear(turn.earlyCueTimer); turn.earlyCueTimer = undefined }
    if (turn.handedCueTimer !== undefined) { this.timers.clear(turn.handedCueTimer); turn.handedCueTimer = undefined }
  }

  // ── The fast path ───────────────────────────────────────────────────────────────────
  /** Start the fast call of a turn now being journaled, or mark the turn governed (the setting off, or not set up). */
  startFast(record, turn) {
    const settings = fastVoiceSettings(this.env)
    if (!settings.on) { turn.path = 'governed'; return }
    turn.path = 'fast'
    // The turn's provider NAME and model id, for its status entry (never a key, never a value).
    turn.fastProvider = settings.provider
    turn.fastModel = settings.model
    // The level of this turn on the anthropic wire: his own words for this turn, or the level he held for
    // the call, when the edge offers it; otherwise the default (a level not offered is noted, never run smaller).
    const effort = settings.wire === 'anthropic' ? this.turnEffort(record, turn, settings) : null
    const bounds = effort ? FAST_EFFORT_LEVELS[effort] : { turnMs: FAST_VOICE_LIMITS.turnMs, firstEventMs: FAST_VOICE_LIMITS.firstEventMs[settings.wire] ?? FAST_VOICE_LIMITS.firstTextMs }
    this.counts.fastTurns++
    const fast = { status: 'running', controller: new AbortController(), reader: null, handoff: false, timer: undefined, deadline: undefined,
      // The wire of this turn's calls; on the anthropic wire, the content blocks of the answer being read
      // (kept verbatim for the next round) and whether it ended in a refusal.
      wire: settings.wire, roundBlocks: null, wantedBlocks: null, refused: false,
      // This turn's tool rounds (the messages replayed to the next call), its calls so far, those pending at
      // the tab, the calls of the round being read, its text, and who waits for the journal confirmation.
      record, rounds: [], round: 0, calls: 0, named: 0, pending: new Map(), roundCalls: [], roundText: '', wanted: null, cued: false, limited: false,
      final: false, waiters: [], awareness: null,
      // the voice safety change V2-2: true once any tool call other than her web search has returned in this turn (sendTool).
      inward: false,
      // This turn's level and the levels offered; whether her think_deeper was taken (once a turn), the
      // model call being re-run (`again`), the calls made (each its own journal id), and whether the current call is alive.
      effort, offered: settings.offered ?? [], escalated: false, again: false, callNo: 0, alive: false, startedAt: this.now(),
      // His words merged into this turn (all, and those the model has not read yet), the whole-turn bound's
      // extensions, whether words of the CURRENT model call were released as hers (`answering`), and the one follow-up
      // call after an answer that his added words still wait on (`follow`, `followed`).
      added: [], addedPending: [], extensions: 0, answering: false, follow: false, followed: false,
      // Her answer was spoken whole and only a follow-up call for his added words runs (no work cue then;
      // a failure of it ends the turn answered). False again once a call ends with tool calls.
      answered: false,
      // What this turn's completed calls returned (for the digest a cut turn leaves), and the digest an
      // earlier cut turn left for this one.
      reads: [], digest: null,
      // The work cues said in this turn and when the last one was.
      workCues: 0, workCueAt: undefined }
    turn.fast = fast
    // No first event (text or a tool call) within the bound: the governed hand-off. Past the whole bound (every round and
    // tool together): the call is stopped.
    // The bound is per wire (FAST_VOICE_LIMITS.firstEventMs): Claude thinks before it writes.
    // Both bounds are the level's (FAST_EFFORT_LEVELS; the chat wire keeps its own).
    this.fastBounds(record, turn, bounds)
    void this.runFast(record, turn, settings).catch(() => {})
  }

  /** The first-event bound of the model call now starting and the whole-turn bound, (re)set from `bounds`. */
  fastBounds(record, turn, bounds) {
    const fast = turn.fast
    for (const name of ['timer', 'deadline']) if (fast[name] !== undefined) { this.timers.clear(fast[name]); fast[name] = undefined }
    fast.alive = false
    fast.firstEventMs = bounds.firstEventMs
    this.armFirstEvent(record, turn)
    fast.deadlineAt = this.now() + bounds.turnMs
    fast.deadline = this.timers.set(() => { fast.deadline = undefined; void this.serial(() => this.fastFail(record, turn, 'turn_bound')) }, bounds.turnMs)
  }

  /** The first-event bound of the model call now starting, set afresh (again after the first-frame wait,
   * so the wait is never spent inside it). */
  armFirstEvent(record, turn) {
    const fast = turn.fast
    if (fast.timer !== undefined) this.timers.clear(fast.timer)
    fast.timer = this.timers.set(() => { fast.timer = undefined; void this.serial(async () => { if (!fast.alive) await this.fastFail(record, turn, 'first_event_bound') }) }, fast.firstEventMs)
  }

  /** The level of this spoken turn, from HIS transcript only (voice-fast.mjs ownerEffort) and the level he
   * held for this call; set on the turn with who chose it, for its status entry. */
  turnEffort(record, turn, settings) {
    const asked = ownerEffort(turn.transcript)
    const offered = settings.offered ?? []
    if (asked.hold === null) record.effortHold = null
    else if (asked.hold !== undefined && offered.includes(asked.hold)) record.effortHold = asked.hold
    const wanted = asked.level ?? record.effortHold ?? null
    turn.effortBy = 'default'
    turn.effort = settings.effort
    if (wanted && offered.includes(wanted)) Object.assign(turn, { effort: wanted, effortBy: 'owner' })
    else if (wanted) turn.effortNotOffered = wanted
    turn.deep = isDeepEffort(turn.effort)
    if (turn.deep) turn.thinkCue = DEEP_CUE
    return turn.effort
  }

  /** The fast call stops (her answer ended, the turn ended or was cut, or the call failed): its timers go, and a call
   * still streaming is aborted (HEAD's dispatcher aborts the provider request with it). */
  stopFast(turn, status = 'stopped') {
    const fast = turn.fast
    if (!fast) return
    for (const name of ['timer', 'deadline']) if (fast[name] !== undefined) { this.timers.clear(fast[name]); fast[name] = undefined }
    if (fast.status !== 'running') return
    fast.status = status
    this.wakeFast(turn)
    if (status === 'ended') return
    fast.controller.abort()
    void fast.reader?.cancel().catch(() => {})
    this.cancelTools(turn)
  }

  /** Whoever waits for this fast turn to be running (journal confirmed) or over is woken. */
  wakeFast(turn) {
    const waiters = turn.fast?.waiters ?? []
    if (turn.fast) turn.fast.waiters = []
    for (const wake of waiters) wake()
  }

  /** True once the turn runs (its journal write confirmed) with its fast call still going; false when it is over. */
  async whenRunning(turn) {
    const fast = turn.fast
    while (fast.status === 'running' && turn.state === 'journaling') await new Promise(resolve => { fast.waiters.push(resolve) })
    return fast.status === 'running' && turn.state === 'running'
  }

  /** Every call of this turn still pending at the tab is answered as cancelled here; the tab is told to stop them. */
  cancelTools(turn) {
    const fast = turn.fast
    if (!fast?.pending.size) return
    for (const pending of fast.pending.values()) pending.settle({ ok: false, text: TOOL_LINES.cancelled, how: 'cancelled' })
    this.toTab(fast.record, { t: 'tool_cancel', turn: turn.turnId })
  }

  /** The tab's answer to one pending call: taken once; a call no longer pending (cut, timed out, a new turn) is dropped. */
  toolResult(record, frame) {
    const turn = [...record.turns.values()].find(item => item.turnId === frame.turn)
    const pending = turn?.fast?.status === 'running' ? turn.fast.pending.get(frame.call) : undefined
    if (!pending) { this.counts.toolResultsDropped++; return }
    // Her tab answered a look (her facts say how). A refused or failed answer is never 'ok'.
    record.lastLook = { ok: frame.ok === true, how: frame.ok === true ? 'ok' : 'refused', at: this.now() }
    pending.settle({ ok: frame.ok, text: boundedResult(frame.text) })
  }

  /** One POST to HEAD, internal and seed-bound, as the turn journal is written. */
  async headPost(record, path, body, headers = {}, signal = undefined) {
    return await this.env.HEAD.get(this.env.HEAD.idFromName('node-main-v1')).fetch(new Request(`https://x61.internal${path}`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': record.seedId, ...headers },
      body,
    }))
  }

  /**
   * The fast call, outside the one-at-a-time chain (each event it reads goes back through `serial`): the request is
   * built from the rules, the awareness and the spoken history; the door's budget is reserved ONCE for each model call,
   * exactly as the provider door reserves a governed turn's model call; its exact request hash is journaled under its own
   * id (`<turn id>.fast`, then `.fast2`, ... for each later call of the same turn; hashes only); then HEAD's dispatcher
   * sends it with the key it alone holds, and the stream is read. When an answer ends asking for tools, they
   * run in her tab (runTools) and the next call carries their results, up to the turn's ceilings.
   */
  async runFast(record, turn, settings) {
    const fast = turn.fast
    try {
      if (!this.env?.HEAD || !HEX_64.test(record.seedId ?? '')) throw new Error('VOICE_FAST_UNREACHABLE')
      // The history from her voice memory, and the facts of it for her Memory line.
      const opened = await this.openMemory(record)
      const history = opened.history
      fast.memory = opened.facts
      // What a cut turn just before this one read; this turn then counts as having read inward from its start.
      // The digest is for the next turn only, however this turn ends: it left storage as this turn took it.
      fast.digest = opened.digest
      if (fast.digest) fast.inward = true
      for (;;) {
        fast.round++
        fast.final = fast.round > FAST_VOICE_LIMITS.toolRounds || fast.calls >= FAST_VOICE_LIMITS.toolCalls
        await this.fastCall(record, turn, settings, history)
        // Her think_deeper was taken: the same round again at the new level (no tool round spent).
        if (fast.status === 'running' && fast.again) { fast.again = false; fast.round--; continue }
        // the voice fix 5a: her answer ended while his added words waited: one more call carries them.
        if (fast.status === 'running' && fast.follow) { fast.follow = false; continue }
        if (fast.status !== 'running' || !fast.wanted) return
        if (!await this.whenRunning(turn)) return
        await this.runTools(record, turn)
        if (fast.status !== 'running') return
      }
    } catch (error) {
      if (fast.status === 'running') await this.serial(() => this.fastFail(record, turn, FAST_FAILURE_REASONS[error?.code ?? error?.message] ?? 'provider_status'))
    }
  }

  /** Before a turn's first model call: on the call's first turn, just after hello and with no frame yet in
   * this call, wait (bounded) for the first frame; then, with no frame for this owner in memory, load the stored one.
   * True when it waited. A frame older than AWARE_KEEP_MS is never used, in memory or stored (the stored
   * one is deleted). */
  async firstAwareness(record, turn) {
    let waited = false
    if (this.aware && !(this.now() - this.aware.at < AWARE_KEEP_MS)) this.aware = null
    const fresh = () => this.aware?.owner === record.owner && this.aware.at >= (record.helloAt ?? Infinity)
    if (record.turnsStarted === 1 && Number.isSafeInteger(record.helloAt) && this.now() - record.helloAt < AWARE_FIRST_HELLO_MS && !fresh() && record.tab) {
      this.counts.awareWaits++
      waited = true
      await new Promise(resolve => {
        const done = () => { this.timers.clear(timer); resolve() }
        const timer = this.timers.set(() => { record.awareWaiters = (record.awareWaiters ?? []).filter(item => item !== done); resolve() }, AWARE_FIRST_WAIT_MS)
        ;(record.awareWaiters ??= []).push(done)
      })
    }
    if (this.aware?.owner === record.owner || !record.owner) return waited
    try {
      const stored = await this.state.storage.get(AWARE_KEY)
      if (isObject(stored) && Number.isSafeInteger(stored.at) && !(this.now() - stored.at < AWARE_KEEP_MS)) await this.state.storage.delete(AWARE_KEY)
      else if (isObject(stored) && stored.owner === record.owner && Number.isSafeInteger(stored.at) && validAwareFrame(stored.frame) && !(this.aware?.owner === record.owner)) {
        this.aware = { owner: stored.owner, frame: stored.frame, at: stored.at }
        this.counts.awareStoredLoads++
      }
    } catch { /* no stored frame: none, as before */ }
    return waited
  }

  /** One model call of a fast turn: budget, journal, dispatch, then its stream read event by event. */
  async fastCall(record, turn, settings, history) {
    const fast = turn.fast
    const signal = fast.controller.signal
    // No word of this model call has been released as hers yet.
    fast.answering = false
    // His added words taken for this call are read from here on; and what her answers covered before this
    // call (a call that turns out to be a line before a look puts it back).
    // `readBefore`: what was read before this call (a follow-up call that fails without a word puts it back).
    fast.readBefore = turn.read
    if (fast.readNext) { turn.read = fast.readNext; fast.readNext = null }
    fast.answeredBefore = turn.answered
    fast.callWords = 0
    // Review: once this call asks for a tool, none of its words is an answer (also those released after the ask).
    fast.calling = false
    // A first-frame wait is not the model's silence: its first-event bound starts again after it.
    if (typeof fast.awareness !== 'string' && await this.firstAwareness(record, turn) && fast.status === 'running' && !fast.alive) this.armFirstEvent(record, turn)
    const aware = this.aware && this.aware.owner === record.owner ? this.aware : null
    // the voice safety change fix 3: the awareness as the turn's FIRST call read it; a later tool round sends the same messages.
    // The facts the edge holds about this voice come first (closed values only), then the awareness, then
    // what a cut turn read (E2).
    if (typeof fast.awareness !== 'string') {
      const facts = voiceFacts({ provider: settings.provider, model: settings.model, served: record.servedModel ?? null, effort: claudeWire(settings) ? fast.effort : null,
        effortBy: turn.effortBy, held: record.effortHold ?? null, now: this.now(), helloAt: record.helloAt, exchanges: Math.max(0, (record.turnsStarted ?? 1) - 1),
        tab: Boolean(record.tab), lastLook: record.lastLook ?? null, aware, memory: fast.memory ?? null })
      fast.awareness = `${facts}\n\n${awarenessMessage(aware, this.now(), record.helloAt)}${fast.digest ? `\n\n${DIGEST_LINE}\n${fast.digest}` : ''}`
    }
    const claude = settings.wire === 'anthropic'
    const request = { model: settings.model, transcript: turn.transcript, aware, history, now: this.now(), rounds: fast.rounds,
      toolChoice: fast.final ? 'none' : 'auto', awareness: fast.awareness }
    // The anthropic wire has its own request builder (its own body shape, never the chat one bent).
    const body = claude ? fastAnthropicBody({ ...request, effort: fast.effort }) : fastRequestBody(request)
    const reservation = providerRequestReservation(encoder.encode(body), settings.limits, settings.endpoint)
    // One journal and dispatch id per model call (a dispatch id is single-use); never the bridge turn-id form.
    // Numbered by model call (a re-run at a new level is a call of its own), not by tool round.
    fast.callNo++
    const fastId = fast.callNo === 1 ? `${turn.turnId}.fast` : `${turn.turnId}.fast${String(fast.callNo)}`
    const requestSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', reservation.bodyBytes))].map(b => b.toString(16).padStart(2, '0')).join('')
    const utteranceSha256 = await sha256Hex(turn.transcript)
    // The budget and the journal row need nothing of each other: both at once. Dispatch waits for both (it claims the
    // row); a budget refusal leaves one undispatched row, which the journal's ring evicts.
    const accepted = async response => response.ok && (await response.json().catch(() => null))?.ok === true
    const [budgeted, journaled] = await Promise.all([
      // REVIEW: with `fallbacks: "default"` one call can run a second model after a decline, which writes up to its own
      // output ceiling (claude-api curl/examples.md, "Refusal Fallbacks": the rescue bills at the fallback model's rates),
      // so the anthropic wire reserves that ceiling twice.
      this.headPost(record, '/_head/provider-budget', JSON.stringify({ provider: settings.provider, tokens: reservation.tokens + (claude ? reservation.outputTokens : 0) }), {}, signal).then(accepted),
      this.headPost(record, '/_head/turn-journal', JSON.stringify({ turnId: fastId, provider: settings.provider, endpoint: settings.endpoint,
        requestedModel: settings.model, requestSha256, utteranceSha256, utteranceBytes: encoder.encode(turn.transcript).byteLength,
        modality: 'voice', voiceId: null }), {}, signal).then(accepted),
    ])
    if (!budgeted) throw new Error('VOICE_FAST_BUDGET')
    if (!journaled) throw new Error('VOICE_FAST_JOURNAL')
    // This call's receipt in the turn's record: its journal id, the exact request digest its journal row
    // holds, then (as they come) the answer's digest, the served model and the provider's request id. Effort: this call's
    // level on the anthropic wire, '' on the chat wire. At most MEMORY_LIMITS.calls a turn.
    const receipt = { id: fastId, req: requestSha256, res: '', model: '', effort: claude && typeof fast.effort === 'string' ? fast.effort : '', rid: '' }
    fast.receipt = receipt
    fast.callText = ''
    fast.callCalls = []
    turn.receipts ??= []
    if (turn.receipts.length < MEMORY_LIMITS.calls) turn.receipts.push(receipt)
    const response = await this.headPost(record, '/_head/provider-dispatch', reservation.bodyBytes,
      { 'x-x6-provider': settings.provider, 'x-x6-provider-endpoint': settings.endpoint, 'x-x6-turn-id': fastId, ...(claude ? { 'anthropic-beta': FAST_ANTHROPIC_BETA } : {}) }, signal)
    // The provider's request id (Anthropic's `request-id` header; the dispatcher passes the upstream's
    // headers through as they came), only in its closed charset and length, else ''.
    const rid = response.headers?.get?.('request-id')
    if (typeof rid === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(rid)) receipt.rid = rid
    if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error('VOICE_FAST_REFUSED') }
    const reader = response.body.getReader()
    fast.reader = reader
    if (fast.status !== 'running') { void reader.cancel().catch(() => {}); return }
    const decoder = new TextDecoder()
    const sse = claude ? createAnthropicSseReader() : createSseReader()
    let bytes = 0
    const deliver = async events => {
      for (const event of events) {
        await this.serial(() => this.fastEvent(record, turn, event))
        if (fast.status !== 'running' || fast.wanted || fast.again || fast.follow) return false
      }
      return true
    }
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > FAST_VOICE_LIMITS.responseBytes) throw new Error('VOICE_FAST_TOO_LARGE')
      if (!await deliver(sse.push(decoder.decode(part.value, { stream: true })))) { void reader.cancel().catch(() => {}); return }
    }
    await deliver([...sse.push(decoder.decode()), ...sse.end()])
  }

  /**
   * The tool calls the last answer asked for, run in her tab. The cue first (once per turn, only when she has
   * said nothing yet); then each call is named, size-checked and sent to the tab (or answered at once when it cannot
   * be: no tab, past the turn's ceiling, arguments too long or not JSON); every answer, or its timeout, is waited for;
   * then the round (the model's own message and one result per call) is kept for the next call.
   */
  async runTools(record, turn) {
    const fast = turn.fast
    const wanted = fast.wanted ?? []
    const text = fast.roundText
    fast.wanted = null
    fast.roundText = ''
    const answers = await this.serial(async () => {
      if (fast.status !== 'running' || turn.state !== 'running') return null
      this.counts.toolRounds++
      if (!fast.cued && !turn.spoken && !turn.quiet) {
        this.clearBackchannel(turn)
        // A cue, never her answer: the early cue is spent with it; the timeout cue may still come if she says nothing.
        this.say(record, turn, TOOL_CUE, 'cue', 'early')
        this.armCues(record, turn)
      }
      fast.cued = true
      return wanted.map(call => this.sendTool(record, turn, call))
    })
    if (!answers) return
    const results = await Promise.all(answers.map(answer => answer.result))
    if (fast.status !== 'running') return
    if (fast.wire === 'anthropic') {
      // The assistant's content blocks exactly as the stream gave them (thinking and its signature
      // included), then ONE user message with every result, each naming the model's own tool_use id.
      const blocks = fast.wantedBlocks ?? []
      fast.wantedBlocks = null
      // the voice fix 5a: his words added while she worked ride in the same user message, as one text block AFTER the
      // last tool_result (claude-api shared/model-migration.md, "Mid-turn user messages": "Deliver mid-turn user input as
      // a user turn - a text block in the user message that carries the tool_result blocks, after the last tool_result").
      const added = this.takeAdded(fast, turn)
      fast.rounds.push({ role: 'assistant', content: blocks },
        // REVIEW: a result refused or failed here or at the tab says so (claude-api shared/tool-use-concepts.md, "Handling
        // Tool Results": "When a tool execution fails, set \"is_error\": true").
        { role: 'user', content: [...answers.map((answer, index) => ({ type: 'tool_result', tool_use_id: answer.modelId, content: toolResultContent(answer.name, results[index].text),
          ...(results[index].ok === false ? { is_error: true } : {}) })), ...(added ? [{ type: 'text', text: addedWordsText('working', added) }] : [])] })
      return
    }
    const added = this.takeAdded(fast, turn)
    fast.rounds.push({ role: 'assistant', content: text || null, tool_calls: answers.map(answer => ({ id: answer.id, type: 'function',
      function: { name: answer.name, arguments: answer.args } })) },
    ...answers.map((answer, index) => ({ role: 'tool', tool_call_id: answer.id, content: toolResultContent(answer.name, results[index].text) })),
    // the voice fix 5a: on the chat wire his added words are one user message after the tool messages.
    ...(added ? [{ role: 'user', content: addedWordsText('working', added) }] : []))
  }

  /** His added words the model has not read yet (joined), now taken; null when there are none. */
  takeAdded(fast, turn) {
    if (!fast.addedPending.length) return null
    const words = fast.addedPending
    fast.addedPending = []
    // The model's NEXT call reads them: the entry they came in is read from that call on (never by the
    // words of the answer still being released).
    fast.readNext = { text: turn.lastHeard ?? turn.full, users: turn.users }
    return words
  }

  /** One tool call: `{ id, name, args, result }` where `result` settles with `{ ok, text }` (from the tab or from here). */
  sendTool(record, turn, call) {
    const fast = turn.fast
    const id = `call_${String(++fast.named)}`
    // The anthropic wire's own tool_use id, which its tool_result must name (the tab sees only `id`).
    const modelId = typeof call.id === 'string' ? call.id : ''
    const name = TOOL_NAME_RE.test(call.name) ? call.name : 'not_a_tool'
    let args = '{}'
    let refused = null
    let outward = false
    if (fast.calls >= FAST_VOICE_LIMITS.toolCalls) refused = TOOL_LINES.tooMany
    else if (name !== call.name) refused = TOOL_LINES.badName
    // A think_deeper the bridge did not take (fastAnswerEnded) is answered here, never sent to the tab.
    else if (name === THINK_TOOL && fast.wire === 'anthropic') {
      const level = thinkLevel(call)
      refused = fast.escalated ? THINK_LINES.already : !level ? THINK_LINES.badLevel : !fast.offered.includes(level) ? THINK_LINES.notOffered : THINK_LINES.notHigher
    }
    else if (name !== LOOK_TOOL && name !== SCRATCH_TOOL) refused = TOOL_LINES.notOffered
    else if (call.cut) refused = TOOL_LINES.tooLong
    else {
      try {
        const parsed = JSON.parse(call.args || '{}')
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) refused = TOOL_LINES.notJson
        else {
          args = call.args || '{}'
          // the voice safety change V2-2: her web search never follows an inward read in the same spoken turn, and its query is bounded.
          outward = outwardLook(name, parsed)
          const query = outward && parsed.args !== null && typeof parsed.args === 'object' ? parsed.args.query : undefined
          if (outward && fast.inward) refused = SEARCH_LINES.afterRead
          else if (typeof query === 'string' && query.length > FAST_SEARCH_QUERY_CHARS) refused = SEARCH_LINES.long
          // The awareness and the spoken history are inward text the first round already holds; a
          // search runs only on his own words of this turn (voice-fast.mjs searchHeard).
          // His added words of this turn count as his words.
          else if (outward && !searchHeard(this.heardWhole(turn), parsed.args)) refused = SEARCH_LINES.unheard
        }
      } catch { refused = TOOL_LINES.notJson }
    }
    if (refused !== TOOL_LINES.tooMany) fast.calls++
    // The call in the turn's status: its tool NAME (offered names only), when it went and came back, how.
    const since = () => Math.max(0, this.now() - turn.arrivedAt)
    const logged = (turn.toolLog ??= []).length < TOOL_LOG_MAX ? { tool: VOICE_TOOL_NAMES.includes(name) ? name : 'other', sentMs: since(), backMs: null, result: null } : null
    if (logged) turn.toolLog.push(logged)
    const answered = (text, result) => { if (logged) Object.assign(logged, { backMs: since(), result }); return { id, modelId, name, args, result: Promise.resolve({ ok: false, text }) } }
    if (refused) return answered(refused, 'refused')
    if (!record.tab) return answered(TOOL_LINES.noTab, 'refused')
    const frame = JSON.stringify({ t: 'tool', turn: turn.turnId, call: id, name, args })
    if (utf8Bytes(frame) > TAB_FRAME_MAX_BYTES) return answered(TOOL_LINES.tooLarge, 'refused')
    this.counts.toolCalls++
    const result = new Promise(resolve => {
      const pending = { settle: answer => {
        if (fast.pending.get(id) !== pending) return
        fast.pending.delete(id)
        this.timers.clear(pending.timer)
        // An inward call has returned (or timed out: what it read may still come back later; count it all the same).
        if (!outward) fast.inward = true
        // A call her tab answered (a refusal, a timeout or a cancel is not a read), for the digest of a cut turn.
        if (answer.ok === true) fast.reads.push({ name, args, text: answer.text })
        if (logged) Object.assign(logged, { backMs: since(), result: answer.how ?? (answer.ok === true ? 'ok' : 'refused') })
        resolve(answer)
      } }
      pending.timer = this.timers.set(() => { void this.serial(async () => {
        if (fast.pending.get(id) !== pending) return
        this.counts.toolTimeouts++
        record.lastLook = { ok: false, how: 'timeout', at: this.now() }
        pending.settle({ ok: false, text: TOOL_LINES.timeout, how: 'timeout' })
      }) }, FAST_VOICE_LIMITS.toolWaitMs)
      fast.pending.set(id, pending)
    })
    this.send(record.tab, frame)
    return { id, modelId, name, args, result }
  }

  /** One event of the fast stream, in order with everything else. */
  async fastEvent(record, turn, event) {
    const fast = turn.fast
    if (!fast || fast.status !== 'running' || turn.path !== 'fast' || !LIVE.has(turn.state)) return
    if (event.error) return await this.fastFail(record, turn, 'provider_status')
    // The anthropic answer's content blocks, kept for the next round (never speech, never stored).
    if (event.blocks) {
      fast.roundBlocks = { blocks: event.blocks, replayable: event.replayable === true }
      // The answer digest of this call (its replay blocks and its stop reason).
      if (fast.receipt) fast.receipt.res = await answerDigest({ blocks: event.blocks, stop: event.stop ?? null })
      return
    }
    // The key names of this call's block starts (the status's streamKeys) and the keys dropped for replay.
    if (event.streamKeys) {
      this.streamKeys = event.streamKeys
      if (Number.isSafeInteger(event.trimmed)) this.counts.blocksTrimmed += event.trimmed
      return
    }
    // REVIEW: the model actually answering (message_start, or a fallback block's target), for the turn's status entry; only
    // an exact Claude id is kept. It is not the model being alive: the first-event bound is untouched.
    // And on the conversation record, for her facts ("last answer served by").
    if (event.model !== undefined) {
      if (FAST_CLAUDE_MODEL_RE.test(event.model)) {
        turn.fastModel = event.model
        record.servedModel = event.model
        if (fast.receipt && event.model.length <= MEMORY_LIMITS.modelChars) fast.receipt.model = event.model
      }
      return
    }
    // Any first event (text, a tool call, or on the anthropic wire a thinking delta) ends the first-event bound; it
    // never applies while her tools run.
    turn.modelFirstAt ??= this.now()
    fast.alive = true
    if (fast.timer !== undefined) { this.timers.clear(fast.timer); fast.timer = undefined }
    // Thinking is the model being alive, never speech: its text never reaches this method.
    if (event.thinking) return
    // stop_reason refusal: the answer is over; she says one plain line and nothing else (fastEnded); no
    // tool runs and the governed path is not asked.
    if (event.refused) {
      fast.refused = true
      this.stopFast(turn, 'ended')
      if (turn.state === 'running') await this.fastEnded(record, turn)
      return
    }
    // A tool call has begun (its first piece): the first-event bound is over; the call itself comes when it is whole.
    // And the words this call has said were a line before a look, not an answer to his words.
    if (event.calling) { fast.calling = true; turn.answered = fast.answeredBefore; return }
    // Tool calls: only noted until the answer ends. Their names and arguments are never text.
    if (event.calls) {
      fast.roundCalls.push(...event.calls)
      fast.callCalls?.push(...event.calls.map(call => ({ name: call.name, args: call.args })))
      return
    }
    if (event.end) {
      // On the chat wire, the answer digest of this call is over her text and its tool calls.
      if (fast.wire !== 'anthropic' && fast.receipt) fast.receipt.res = await answerDigest({ text: fast.callText ?? '', calls: fast.callCalls ?? [] })
      return await this.fastAnswerEnded(record, turn)
    }
    if (typeof fast.callText === 'string') fast.callText += event.text
    if (fast.roundText.length < 4000) fast.roundText = (fast.roundText + event.text).slice(0, 4000)
    // Held while the journal write is unconfirmed; released through the same clause rules once it is.
    this.gather(turn, event.text, turn.state === 'running')
    if (turn.state === 'running') this.flush(record, turn, false)
  }

  /**
   * One model answer ended. The hand-off (its tool, or its name written as text) wins over any other call; no call, or
   * calls asked after the last round: the turn's answer is over. Otherwise its tools run (runFast) and the next call
   * follows; the words of this answer are released whole first, with a space before the next answer's.
   */
  async fastAnswerEnded(record, turn) {
    const fast = turn.fast
    const calls = fast.roundCalls
    fast.roundCalls = []
    const handing = calls.find(call => call.name === HAND_OFF_TOOL)
    if (handing) {
      fast.handoff = true
      // His words are handed to her working self: finished with here (her hand-off line is their answer).
      turn.answered = turn.read
      // His added words of this turn are his words too.
      turn.handTo = this.handOffTitle(record, handing, this.heardOf(turn))
      // the voice safety change 9b: a conversation was named but not honoured: it goes to her voice thread, and she says so.
      if (turn.handTo === undefined && this.handOffNamed(handing)) turn.handUnsure = true
    }
    // Her think_deeper, taken once a turn when it names an offered level above this turn's: the round is
    // discarded and the same turn runs again at that level. Any other think_deeper is answered as a tool call (sendTool).
    const deeper = fast.handoff || fast.final || fast.escalated || fast.wire !== 'anthropic' ? undefined : calls.find(call => call.name === THINK_TOOL)
    const level = deeper ? thinkLevel(deeper) : null
    if (level && fast.offered.includes(level) && effortRank(level) > effortRank(fast.effort)) return this.thinkDeeper(record, turn, level)
    // the voice fix 5a: the call ended with her answer and no tool call while his added words wait: the answer is spoken as
    // today, then ONE more call replays it and carries his words (an empty reply ends the turn with no more words).
    // Again for words he added during a follow-up call (the merge cap bounds it), never dropped.
    if (!fast.handoff && !calls.length && fast.addedPending.length) {
      const answered = fast.roundBlocks
      fast.roundBlocks = null
      if (fast.wire !== 'anthropic' || answered?.replayable) {
        const added = this.takeAdded(fast, turn)
        fast.followed = true
        fast.follow = true
        fast.answered = true
        fast.rounds.push(fast.wire === 'anthropic' ? { role: 'assistant', content: answered.blocks } : { role: 'assistant', content: fast.roundText || '(she said nothing)' },
          fast.wire === 'anthropic' ? { role: 'user', content: [{ type: 'text', text: addedWordsText('answering', added) }] } : { role: 'user', content: addedWordsText('answering', added) })
        fast.roundText = ''
        if (turn.state === 'running') this.flush(record, turn, true)
        else if (turn.pending && !/\s$/.test(turn.pending)) turn.pending += ' '
        if (turn.said && !/\s$/.test(turn.said)) turn.said += ' '
        // That call's answer ended whole (however short): what it read is answered. His added words ride
        // in the follow-up call and are not (takeAdded moved `read` only for that next call).
        if (fast.callWords > 0) turn.answered = turn.read
        return
      }
    }
    if (fast.handoff || !calls.length || fast.final) {
      // Tools asked for after the ceiling are not run: she closes in a plain line instead.
      if (!fast.handoff && calls.length && fast.final) fast.limited = true
      this.stopFast(turn, 'ended')
      if (turn.state === 'running') await this.fastEnded(record, turn)
      return
    }
    // On the anthropic wire the next round replays this answer's blocks exactly; an answer that cannot be
    // replayed exactly (a block type outside text/thinking/tool_use, such as a fallback switch point) is not continued.
    const round = fast.roundBlocks
    fast.roundBlocks = null
    if (fast.wire === 'anthropic') {
      if (!round?.replayable) return await this.fastFail(record, turn, 'unreplayable')
      fast.wantedBlocks = round.blocks
    }
    fast.wanted = calls
    // This call's words were a line before a look, not an answer to his words (its last clause, released
    // just below or when the journal write is confirmed, is no answer either: `calling`).
    fast.calling = true
    turn.answered = fast.answeredBefore
    if (turn.state === 'running') this.flush(record, turn, true)
    else if (turn.pending && !/\s$/.test(turn.pending)) turn.pending += ' '
    if (turn.said && !/\s$/.test(turn.said)) turn.said += ' '
    // Words of a call that ends with tool calls were an announcement, not the answer.
    fast.answering = false
    fast.answered = false
  }

  /** Take her think_deeper: what this round wrote and was not said is dropped (its blocks, its thinking,
   * its calls are never replayed); one cue; the same messages go again at `level`, with that level's bounds. */
  thinkDeeper(record, turn, level) {
    const fast = turn.fast
    Object.assign(fast, { escalated: true, again: true, effort: level, roundBlocks: null, roundText: '', wanted: null, wantedBlocks: null })
    Object.assign(turn, { effort: level, effortBy: 'self', deep: isDeepEffort(level), thinkCue: THINK_CUE, thinkCueSaid: false,
      pending: '', block: null, blockTail: false, discard: null })
    // Review 2026-11-16: the new level's whole bound counts from the turn's start, never afresh from here.
    const bounds = FAST_EFFORT_LEVELS[level]
    // And keeps the extensions his merged words already earned.
    this.fastBounds(record, turn, { firstEventMs: bounds.firstEventMs, turnMs: Math.max(0, fast.startedAt + bounds.turnMs + fast.extensions * MERGE_LIMITS.extendMs - this.now()) })
    if (turn.state === 'running') this.armCues(record, turn)
  }

  /** the voice tools V5: the conversation a hand-off names, only when its title is EXACTLY one her tab's awareness listed for
   * this owner (the model's other words never reach the tab); otherwise undefined (her voice thread, as before).
   * the voice safety change 9b: and only when exactly ONE listed conversation has that title and his own words of this turn
   * (`heard`) contain at least one distinctive word of it (voice-fast.mjs heardNamesTitle): an ambiguous "yes, do it"
   * never routes his governed prompt into a conversation the model picked. */
  handOffTitle(record, call, heard) {
    const named = this.handOffNamed(call)
    if (named === undefined) return undefined
    const aware = this.aware && this.aware.owner === record.owner ? this.aware.frame : null
    const listed = aware?.threads.filter(thread => thread.title === named).length ?? 0
    return listed === 1 && heardNamesTitle(heard, named) ? named : undefined
  }

  /** The conversation title a hand-off call names, when it names one at all (a non-empty string within the bound). */
  handOffNamed(call) {
    let named
    try { named = JSON.parse(call.args || '{}')?.conversation } catch { return undefined }
    return typeof named === 'string' && named.trim() && named.length <= HAND_OFF_TITLE_CHARS ? named : undefined
  }

  /** The fast call failed, or was silent past its bound, or ran past its whole bound. */
  async fastFail(record, turn, reason = 'provider_status') {
    if (!turn.fast || turn.fast.status !== 'running' || turn.path !== 'fast' || !LIVE.has(turn.state)) return
    // The closed reason the fast call ended without its answer (kept when the governed path then answers).
    turn.endReason ??= reason
    // Whether the failed call is the follow-up after her whole answer, and whether it said anything.
    const { answered, answering } = turn.fast
    this.stopFast(turn, 'failed')
    if (answered && turn.spoken && turn.state === 'running') {
      // Her answer was spoken whole; only the follow-up call for his added words failed. The turn ends answered (its
      // reason kept): no look line (she was not looking), no interrupted mark. His added words were not answered, so she
      // says so, unless that call had already begun to answer them.
      // A follow-up call that said nothing read his added words in vain: they are not read, so the
      // done turn does not count them answered (she says below that she did not get to them).
      if (!(turn.fast.callWords > 0)) turn.read = turn.fast.readBefore ?? turn.read
      if (!answering || turn.fast.addedPending.length) this.sayAddedDropped(record, turn)
      else Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
      this.sendSpoken(record, turn)
      return await this.finish(record, turn, 'done')
    }
    await this.fallBack(record, turn)
  }

  /** His added words could not reach the model before her turn ended (the tool limit, an answer that
   * cannot be replayed, a failed call): she says so in one plain line, through the same speakable rules as her words, so
   * the kept exchange says it too. Text the ended call wrote and she did not say is dropped first. */
  sayAddedDropped(record, turn) {
    if (turn.quiet || turn.state !== 'running') return
    Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
    const last = turn.sent.at(-1) ?? ''
    this.gather(turn, `${last && !/\s$/.test(last) ? ' ' : ''}${ADDED_DROPPED_LINE}`, true)
    this.flush(record, turn, true)
  }

  /** ONCE, AND NEVER BOTH: a fast turn that has spoken nothing goes to the governed path (anything it wrote but did not
   * say is dropped); one that has spoken ends there, as a failed turn. A turn still being journaled is handed over when
   * the journal write is confirmed (advance). */
  async fallBack(record, turn) {
    this.counts.fastFallbacks++
    if (turn.spoken) {
      // Review 2026-11-16: she said a line while her tools ran (or the cue), then the look ended without an answer (its
      // time ceiling, a later model call refused, a bad stream line): one plain closing line, never silence after it.
      if (!turn.quiet && (turn.fast?.cued || turn.fast?.rounds.length)) this.say(record, turn, ` ${TOOL_LIMIT_LINE}`, 'fixed')
      // And his added words the model never read are not dropped in silence.
      if (turn.fast?.addedPending.length) this.sayAddedDropped(record, turn)
      return await this.finish(record, turn, 'fail', 'VOICE_TURN_FAILED')
    }
    Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
    // Review 2026-11-16: a deep attempt he heard only cues of says once that it ran out, before the governed hand-off.
    if (turn.deep && turn.state === 'running' && !turn.quiet && !record.ended) this.say(record, turn, DEEP_FELL_BACK_CUE, 'cue', 'early')
    turn.path = 'fast_fell_back'
    if (turn.state === 'running') await this.handToTab(record, turn)
  }

  /** Her fast answer ended: its tail released; a hand-off goes to the tab as a governed turn after her line; an answer
   * with no spoken word falls back; otherwise the turn is done and the tab is told what was said. */
  async fastEnded(record, turn) {
    if (turn.fast.refused) {
      // What the refused answer wrote and was not yet said is dropped; then her one plain line, alone.
      Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
      const before = turn.said ?? ''
      this.gather(turn, `${turn.said && !/\s$/.test(turn.said) ? ' ' : ''}${FAST_REFUSAL_LINE}`, true)
      this.flush(record, turn, true)
      // REVIEW: the declined partial already said is discarded, never kept as her answer (claude-api
      // shared/model-migration.md, "`refusal` stop reason": "discard the partial output rather than treating it as
      // complete"): the tab and the spoken history hold only what was said after it, her line.
      turn.said = String(turn.said ?? '').slice(before.length).trim()
      this.sendSpoken(record, turn)
      return await this.finish(record, turn, 'done')
    }
    // Past the turn's tool ceiling, her plain closing line (through the same speakable rules).
    if (turn.fast.limited && !turn.fast.handoff) this.gather(turn, `${turn.pending && !/\s$/.test(turn.pending) ? ' ' : ''}${TOOL_LIMIT_LINE}`, true)
    // His added words still unread when her answer ended (the tool limit, an answer that cannot be
    // replayed): one plain line, never silence. A turn that said nothing falls back and hands them over instead.
    if (!turn.fast.handoff && turn.fast.addedPending.length && (turn.spoken || turn.pending.trim())) {
      this.gather(turn, `${turn.pending && !/\s$/.test(turn.pending) ? ' ' : ''}${ADDED_DROPPED_LINE}`, true)
      turn.fast.addedPending = []
    }
    // the voice safety change 9b: the conversation she named was not honoured; she says where it went instead.
    if (turn.fast.handoff && turn.handUnsure) this.gather(turn, `${turn.pending && !/\s$/.test(turn.pending) ? ' ' : ''}${HAND_OFF_UNSURE_LINE}`, true)
    this.flush(record, turn, true)
    if (turn.fast.handoff) {
      this.counts.fastHandoffs++
      this.sendSpoken(record, turn)
      // The next fast prompt knows at once what he asked and that it was handed over; its record is written when its done
      // arrives (with what was spoken).
      await this.putPending(record, turn)
      return await this.handToTab(record, turn)
    }
    if (!turn.spoken) return await this.fallBack(record, turn)
    this.sendSpoken(record, turn)
    await this.finish(record, turn, 'done')
  }

  /** The tab hears each fast exchange (his words, her words) for her next governed prompt in the voice thread. */
  sendSpoken(record, turn, suffix = '') {
    if (!turn.said) return
    const { heard, said } = exchangeOf(this.heardOf(turn), turn.said, 0, null, suffix)
    this.toTab(record, { t: 'spoken', turn: turn.turnId, heard, said })
  }

  /** A turn that spoke (or, on the fast path, read) and then ended without its answer (cut by his newer words, failed,
   * its tab or call gone): a fast turn's words go to the tab marked as cut, once (a handed turn's tab heard its line at
   * hand-off), and the voice memory: the exchange becomes one record of her voice memory, `ended` cut or failed, her words with
   * the interruption marker (SPOKEN_CUT; the model reads it as SPOKEN_INTERRUPTED), and the reads a fast turn left for the
   * next turn beside it. */
  async keepCutExchange(record, turn, ended = 'cut') {
    // A turn cut after its tool results came back is kept even when it said nothing: it carries what it read.
    const digest = turn.path === 'fast' ? readDigest(turn.fast?.reads ?? []) : null
    if ((!turn.said && !digest) || turn.cutKept) return
    turn.cutKept = true
    if (turn.path === 'fast' && turn.handedAt === undefined) this.sendSpoken(record, turn, SPOKEN_CUT)
    await this.keepExchange(record, turn, ended, `${cutWords(turn.said, MEMORY_LIMITS.saidChars - SPOKEN_CUT.length)}${SPOKEN_CUT}`, digest)
  }

  /** Her voice memory for `owner`, the head and the tail (none for another owner). The old spoken store is
   * deleted the first time this object reads (its exchanges carry no salt and no chain: they are never converted).
   * Null when storage could not be read: a failed read is never "this edge has no head", so
   * nothing is adopted, overwritten or moved back on it.
   * Null also when the head stored here is ANOTHER owner's. This object is one for the whole node and
   * its memory keys are single: a second identity never overwrites, adopts over or reads the first one's record (it
   * gets no voice memory until a person decides); appendExchange refuses the same way and counts it. */
  async readMemory(owner) {
    try {
      if (!this.legacyChecked) {
        if (await this.state.storage.get(LEGACY_SPOKEN_KEY) !== undefined) await this.state.storage.delete(LEGACY_SPOKEN_KEY)
        this.legacyChecked = true
      }
      const [head, tail] = await Promise.all([this.state.storage.get(MEMORY_KEYS.head), this.state.storage.get(MEMORY_KEYS.tail)])
      if (owner && isObject(head) && typeof head.owner === 'string' && head.owner !== owner) return null
      if (!owner || !isObject(head) || head.owner !== owner) return { head: null, tail: [] }
      return { head, tail: Array.isArray(tail) ? tail : [] }
    } catch { return null }
  }

  /** A turn of this object that is still live (journaling or running) with `turnId`. */
  liveTurn(turnId) {
    for (const item of this.convs.values()) for (const turn of item.turns.values()) if (turn.turnId === turnId && LIVE.has(turn.state)) return true
    return false
  }

  /** What a fast turn opens with: the history (memoryHistory: the last exchanges of the tail and a pending
   * hand-off, ages for an earlier call's), the digest a cut turn left (taken now: it leaves storage), and the facts of her
   * Memory line (null when her memory could not be read: no Memory line rather than a wrong one).
   * A pending hand-off whose turn is live in no call of this object (the object restarted, or the fast
   * voice was off when its done came) is written once into her chain as `failed`, at its own time, and leaves storage. */
  async openMemory(record) {
    let pending = null, digest = null, lastCallAt = null
    try {
      const [storedPending, storedDigest, history] = await Promise.all([this.state.storage.get(MEMORY_PENDING_KEY), this.state.storage.get(MEMORY_DIGEST_KEY), this.state.storage.get(HISTORY_KEY)])
      if (isObject(storedPending) && storedPending.owner === record.owner) pending = storedPending
      if (isObject(storedDigest) && storedDigest.owner === record.owner) digest = pendingDigest(storedDigest)
      // A start nobody claimed (readAdmission's 'unclaimed' row with lastedSeconds 0, 2026-11-18) was never a call: her
      // "last call ended" fact skips it, as it did before that row existed.
      const calls = isObject(history) && Array.isArray(history.calls) ? history.calls.filter(call => isObject(call) && Number.isSafeInteger(call.atMs)
        && !(call.ended === 'unclaimed' && call.lastedSeconds === 0)) : []
      lastCallAt = calls.at(-1)?.atMs ?? null
      if (storedDigest !== undefined) await this.state.storage.delete(MEMORY_DIGEST_KEY)
    } catch { /* none: as before */ }
    if (pending && !this.liveTurn(pending.turnId)) {
      await this.keepOrphan(record, pending)
      pending = null
    }
    const memory = await this.readMemory(record.owner)
    if (!memory) return { history: [], digest, facts: null }
    const history = memoryHistory(memory.tail, pending, record.conv.slice(0, MEMORY_LIMITS.convChars), this.now(), record.helloAt)
    return { history, digest, facts: { exchanges: memory.head?.seq ?? 0, inFront: history.length, lastCallAt, notInHome: this.notInHome(record, memory.head) } }
  }

  /** An orphaned hand-off becomes one `failed` record (its words as the hand-off kept them, no call
   * receipts: they died with the object). One the record format cannot hold is only removed. A failed write leaves it for
   * the next call (never a lost word). */
  async keepOrphan(record, pending) {
    const fits = typeof pending.turnId === 'string' && pending.turnId.length <= MEMORY_LIMITS.turnChars && typeof pending.conv === 'string'
      && typeof pending.heard === 'string' && typeof pending.said === 'string' && Number.isSafeInteger(pending.atMs) && pending.atMs >= 0
    if (!fits) return await this.state.storage.delete(MEMORY_PENDING_KEY).catch(() => null)
    await this.appendExchange(record, { at: pending.atMs, conv: pending.conv.slice(0, MEMORY_LIMITS.convChars), turn: pending.turnId,
      heard: pending.heard, said: pending.said, ended: 'failed', path: 'governed', calls: [] })
  }

  /** How many records her home has not acknowledged, or null when her home has not said where it is in this
   * call (the frames: M3). */
  notInHome(record, head) {
    if (!record.memoryChecked || !head) return null
    return Math.max(0, head.seq - (record.memorySynced ?? 0))
  }

  /** A fast hand-off's exchange as the next prompt reads it until its record is written at `done`. */
  async putPending(record, turn) {
    if (!fastVoiceSettings(this.env).on || !record.owner || !turn.said) return
    const { heard, said } = exchangeOf(this.heardOf(turn), turn.said, 0, null, SPOKEN_HANDED)
    await this.state.storage.put(MEMORY_PENDING_KEY, { owner: record.owner, conv: record.conv.slice(0, MEMORY_LIMITS.convChars), turnId: turn.turnId, heard, said, atMs: this.now() }).catch(() => null)
  }

  /**
   * ONE finished exchange becomes ONE record of her voice memory (voice-memory.mjs makeExchange), its
   * words beside it, written in ONE storage transaction with the head and the tail (the last MEMORY_LIMITS.tail); when
   * another owner's record is stored here nothing is written (appendExchange). The digest a cut turn left for the next turn is kept beside it (any later exchange
   * without one removes it); a pending hand-off of this turn is replaced. Fast voice on only: with it off the bridge
   * stores no words. Returns the `{ record, words }` written, or null.
   */
  async keepExchange(record, turn, ended, said, digest = null) {
    if (!fastVoiceSettings(this.env).on || !record.owner) return null
    const path = turn.path === 'fast' && !turn.fast?.handoff ? 'fast' : 'governed'
    return await this.appendExchange(record, { at: this.now(), conv: record.conv.slice(0, MEMORY_LIMITS.convChars), turn: turn.turnId,
      heard: this.heardOf(turn), said, ended, path, calls: turn.receipts ?? [] }, async tx => {
      if (digest) await tx.put(MEMORY_DIGEST_KEY, { owner: record.owner, digest })
      else await tx.delete(MEMORY_DIGEST_KEY)
    })
  }

  /** One record appended for `record.owner` in ONE transaction: the head, the tail, the digest index
   * (review), `more(tx)`, and the pending hand-off of the same turn removed. Counted and sent to her home when written. */
  async appendExchange(record, exchange, more = async () => {}) {
    let written = null, other = false
    await this.state.storage.transaction(async tx => {
      const stored = await tx.get(MEMORY_KEYS.head)
      // Another owner's record is never overwritten by a new chain (nothing of this exchange is kept).
      if (isObject(stored) && typeof stored.owner === 'string' && stored.owner !== record.owner) { other = true; return }
      const head = isObject(stored) && stored.owner === record.owner && Number.isSafeInteger(stored.seq) ? stored : null
      const kept = head ? await tx.get(MEMORY_KEYS.tail) : []
      const made = await makeExchange({ prev: head?.digest ?? ZERO_DIGEST, seq: (head?.seq ?? 0) + 1, ...exchange })
      const digest = await recordDigest(made.record)
      await tx.put(MEMORY_KEYS.head, { owner: record.owner, seq: made.record.seq, digest, at: exchange.at })
      await tx.put(MEMORY_KEYS.tail, [...(Array.isArray(kept) ? kept : []), made].slice(-MEMORY_LIMITS.tail))
      await this.indexDigest(tx, record.owner, made.record.seq, digest, !head)
      if (!head) await tx.delete(MEMORY_KEYS.synced)
      await more(tx)
      const pending = await tx.get(MEMORY_PENDING_KEY)
      if (isObject(pending) && pending.turnId === exchange.turn) await tx.delete(MEMORY_PENDING_KEY)
      written = made
    }).catch(() => null)
    if (other) this.counts.memoryOtherOwner++
    if (written) {
      this.counts.memoryRecords++
      await this.sendMemory(record)
    }
    return written
  }

  /** The digest of the record at `seq` into the index (inside the caller's transaction); `fresh`
   * starts a new epoch at `seq` (a new chain, or a head adopted from her home). */
  async indexDigest(tx, owner, seq, digest, fresh) {
    let meta = fresh ? null : await tx.get(MEMORY_INDEX_KEY)
    if (!(isObject(meta) && meta.owner === owner && typeof meta.epoch === 'string' && Number.isSafeInteger(meta.from))) {
      const epoch = [...crypto.getRandomValues(new Uint8Array(8))].map(byte => byte.toString(16).padStart(2, '0')).join('')
      meta = { owner, epoch, from: seq }
      await tx.put(MEMORY_INDEX_KEY, meta)
    }
    const key = indexChunkKey(seq)
    const chunk = await tx.get(key)
    const digests = isObject(chunk) && chunk.owner === owner && chunk.epoch === meta.epoch && isObject(chunk.digests) ? chunk.digests : {}
    await tx.put(key, { owner, epoch: meta.epoch, digests: { ...digests, [String(seq)]: digest } })
  }

  /** The flags of her home for `owner` (a fresh set for another owner), or null when unreadable. */
  async memoryFlags(owner) {
    try {
      const stored = await this.state.storage.get(MEMORY_FLAGS_KEY)
      return isObject(stored) && stored.owner === owner ? stored : { owner, gapFrom: null, adoptedFromHome: false, fork: false }
    } catch { return null }
  }

  /** The digest of the record at `seq` as the edge holds it (its head, the next record's `prev`, a record of the tail, or
   * (review) the digest index), null when the edge never held it (below an adopted head, or before the index), and
   * undefined when storage could not be read (nothing may move on that). */
  async digestAt(head, tail, seq) {
    if (seq === 0) return ZERO_DIGEST
    if (seq === head.seq) return head.digest
    const next = tail.find(item => item.record.seq === seq + 1)
    if (next) return next.record.prev
    const own = tail.find(item => item.record.seq === seq)
    if (own) return await recordDigest(own.record)
    try {
      const meta = await this.state.storage.get(MEMORY_INDEX_KEY)
      if (!(isObject(meta) && meta.owner === head.owner && typeof meta.epoch === 'string' && Number.isSafeInteger(meta.from) && seq >= meta.from)) return null
      const chunk = await this.state.storage.get(indexChunkKey(seq))
      const found = isObject(chunk) && chunk.owner === head.owner && chunk.epoch === meta.epoch && isObject(chunk.digests) ? chunk.digests[String(seq)] : undefined
      return typeof found === 'string' && HEX_64.test(found) ? found : null
    } catch { return undefined }
  }

  /**
   * Her home's word. `memory_ack`: her home appended through seq;
   * `synced` moves when the edge holds that digest there. `memory_nack`: FORK stops every append to her home (shown until
   * a person decides); WRITE_FAILED is retried with the next frame, from her home's head; GAP is her home's head, read as
   * `memory_have`. `memory_have` (her home's head): an edge with no head adopts it (counted); a home ahead of the edge, or
   * with another digest at a seq the edge holds (in the tail or, review, in the digest index), is a FORK; a home behind
   * gets the rest resent in order (sendMemory). Review (MUST): when storage cannot be read, nothing happens at all.
   */
  async memoryFrame(record, frame) {
    const owner = record.owner
    if (!fastVoiceSettings(this.env).on || !owner) return
    const memory = await this.readMemory(owner)
    const flags = await this.memoryFlags(owner)
    if (!memory || !flags) return
    const { head, tail } = memory
    if (frame.t === 'memory_ack') {
      this.counts.memoryAcks++
      if (head && frame.seq <= head.seq && await this.digestAt(head, tail, frame.seq) === frame.digest) {
        const synced = await this.state.storage.get(MEMORY_KEYS.synced)
        if (!(Number.isSafeInteger(synced) && synced >= frame.seq)) await this.state.storage.put(MEMORY_KEYS.synced, frame.seq)
        record.memorySynced = Math.max(record.memorySynced ?? 0, frame.seq)
        record.memoryChecked = true
      }
      return
    }
    if (frame.t === 'memory_nack') {
      this.counts.memoryNacks++
      if (frame.code === 'FORK') return await this.state.storage.put(MEMORY_FLAGS_KEY, { ...flags, fork: true })
      if (frame.code === 'WRITE_FAILED') { record.memorySent = Math.min(record.memorySent ?? frame.seq, frame.seq); return }
    }
    const known = head && frame.seq <= head.seq ? await this.digestAt(head, tail, frame.seq) : null
    if (known === undefined) return
    record.memoryChecked = true
    record.memorySynced = frame.seq
    if (!head) {
      // Review: both empty, everything of this call is sent from seq 1.
      if (frame.seq === 0) { record.memorySent = 0; return }
      // An edge with no head and her home with one: the edge adopts it, with an empty tail (counted, shown).
      await this.state.storage.transaction(async tx => {
        await tx.put(MEMORY_KEYS.head, { owner, seq: frame.seq, digest: frame.digest, at: this.now() })
        await tx.put(MEMORY_KEYS.tail, [])
        await tx.put(MEMORY_KEYS.synced, frame.seq)
        await tx.put(MEMORY_FLAGS_KEY, { ...flags, adoptedFromHome: true })
        await this.indexDigest(tx, owner, frame.seq, frame.digest, true)
      })
      this.counts.memoryAdoptedFromHome++
      record.memorySent = frame.seq
      return
    }
    if (frame.seq > head.seq || (known !== null && known !== frame.digest)) return await this.state.storage.put(MEMORY_FLAGS_KEY, { ...flags, fork: true })
    await this.state.storage.put(MEMORY_KEYS.synced, frame.seq)
    record.memorySent = frame.seq
    await this.sendMemory(record)
  }

  /** Everything above what was sent to her home in this call that the tail still holds, in order, in
   * frames of at most MEMORY_LIMITS.frameItems items and frameBytes bytes; what the tail no longer holds is a GAP, shown
   * and bridged with a gap record first. Only once her home has said where it is in this call, never while it forked,
   * never on a failed read. Review: the gap record's `at` is the first resent record's, so a resend is byte-identical. */
  async sendMemory(record) {
    if (!record.tab || !record.memoryChecked || !Number.isSafeInteger(record.memorySent)) return
    const flags = await this.memoryFlags(record.owner)
    if (!flags || flags.fork) return
    const memory = await this.readMemory(record.owner)
    if (!memory) return
    const { head, tail } = memory
    if (!head || head.seq <= record.memorySent) return
    const from = record.memorySent + 1
    const items = tail.filter(item => item.record.seq >= from)
    if (!items.length) return
    if (items[0].record.seq > from) {
      items.unshift({ record: makeGap({ missingFrom: from, missingTo: items[0].record.seq - 1, prev: items[0].record.prev, at: items[0].record.at }) })
      await this.state.storage.put(MEMORY_FLAGS_KEY, { ...flags, gapFrom: from })
    }
    let batch = []
    const flushBatch = () => {
      if (batch.length) this.toTab(record, { t: 'memory', items: batch })
      batch = []
    }
    for (const item of items) {
      const next = [...batch, item]
      if (next.length > MEMORY_LIMITS.frameItems || utf8Bytes(JSON.stringify({ t: 'memory', items: next })) > MEMORY_LIMITS.frameBytes) {
        flushBatch()
        // One item alone over the frame's bound is never sent: what follows waits (her home's next have says where it is).
        if (utf8Bytes(JSON.stringify({ t: 'memory', items: [item] })) > MEMORY_LIMITS.frameBytes) break
      }
      batch.push(item)
      if (item.record.kind === 'exchange') record.memorySent = item.record.seq
    }
    flushBatch()
  }

  /** The bridge alarm is set for when the stored awareness frame lapses (its time plus AWARE_KEEP_MS).
   * Her voice memory never lapses; nothing of it is swept. */
  async armSweep() {
    try {
      const aware = await this.state.storage.get(AWARE_KEY)
      if (isObject(aware) && Number.isSafeInteger(aware.at) && typeof this.state.storage.setAlarm === 'function') await this.state.storage.setAlarm(aware.at + AWARE_KEEP_MS)
    } catch { /* the next read deletes it */ }
  }

  /** The Durable Object alarm: the stored awareness frame is deleted once it lapses (and the old spoken store, if one is
   * still there); her voice memory is never touched. */
  async alarm() {
    await this.serial(async () => {
      const now = this.now()
      const aware = await this.state.storage.get(AWARE_KEY)
      if (aware !== undefined && !(isObject(aware) && Number.isSafeInteger(aware.at) && now - aware.at < AWARE_KEEP_MS)) await this.state.storage.delete(AWARE_KEY)
      if (this.aware && !(now - this.aware.at < AWARE_KEEP_MS)) this.aware = null
      if (await this.state.storage.get(LEGACY_SPOKEN_KEY) !== undefined) await this.state.storage.delete(LEGACY_SPOKEN_KEY)
      await this.armSweep()
    })
  }

  /** The journal row: hashes and the byte count only. What the owner says is never stored in the journal (they reach the
   * page in the `turn` frame; nothing reads them back from the journal); the only words the bridge keeps are her voice
   * memory's (MEMORY_KEYS, fast path on only). */
  async envelope(turn) {
    const canonical = JSON.stringify({ protocol: VOICE_BRIDGE_PROTOCOL, turnId: turn.turnId, transcript: turn.transcript, voiceAuthority: 'none' })
    return { requestSha256: await sha256Hex(canonical), utteranceSha256: await sha256Hex(turn.transcript),
      utteranceBytes: encoder.encode(turn.transcript).byteLength }
  }

  /** One call to HEAD's existing turn journal. `ok`: the write was accepted. `settled`: HEAD gave an answer that a retry
   * would not change (accepted, or a 4xx refusal); no answer, a 5xx or an unreadable body is not settled. */
  async journal(seedId, payload) {
    if (!this.env?.HEAD || !HEX_64.test(seedId ?? '')) return { ok: false, settled: true }
    try {
      const response = await this.env.HEAD.get(this.env.HEAD.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_head/turn-journal', {
        method: 'POST', signal: AbortSignal.timeout(JOURNAL_DEADLINE_MS),
        headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId },
        body: JSON.stringify(payload),
      }))
      const body = await response.json().catch(() => null)
      if (response.ok && body?.ok === true) return { ok: true, settled: true }
      return { ok: false, settled: response.status >= 400 && response.status < 500 && isObject(body) }
    } catch {
      return { ok: false, settled: false }
    }
  }

  /** A terminal write (complete, or cancel for a cut or abandoned turn): tried now, then retried on its own timer (5
   * tries in all, spaced) until HEAD settles it. A cancel that never settles ends its conversation. */
  async terminalWrite(record, payload) {
    await this.attemptWrite({ conv: record.conv, seedId: record.seedId, payload, tries: 0, timer: undefined })
  }

  async attemptWrite(write) {
    write.tries++
    const result = await this.journal(write.seedId, write.payload)
    if (result.settled) {
      const waited = this.writes.delete(write)
      if (waited && write.payload.action === 'cancel') {
        const record = this.convs.get(write.conv)
        if (record) await this.advance(record)
      }
      return
    }
    if (write.tries >= BRIDGE_LIMITS.journalTries) {
      this.writes.delete(write)
      this.counts.journalWritesLost++
      const record = write.payload.action === 'cancel' ? this.convs.get(write.conv) : undefined
      if (record) await this.endConversation(record, 'journal-unavailable')
      return
    }
    this.counts.journalRetries++
    this.writes.add(write)
    write.timer = this.timers.set(() => { write.timer = undefined; void this.serial(() => this.attemptWrite(write)) }, JOURNAL_RETRY_MS[write.tries - 1])
  }

  /** Text that already passed the rules (or the fixed sentence / a cue) goes to the provider as one chunk. Only real
   * words mark the turn as spoken and clear the cue timers: a cue ('cue', with `cue` early or timeout) does neither.
   * Only HER words (`kind` 'hers') set the time of her first words: the edge's own fixed sentence ('fixed': LOST_PLACE,
   * a FAIL_LINES line) never does. At most 256 chunks are kept for a retry. */
  say(record, turn, content, kind = 'hers', cue = null) {
    turn.sent.push(content)
    // What kind each kept chunk was and when it went out; `cutFrom`, where the words begin that the provider
    // may not have spoken yet (her words are picked up after a cut from these). A pick-up starts that stretch at itself.
    if (!turn.sentKinds) { turn.sentKinds = []; turn.sentAts = [] }
    turn.sentKinds.push(kind)
    turn.sentAts.push(this.now())
    turn.sentTotal++
    if (kind === 'resume' || turn.cutFrom === undefined) turn.cutFrom = turn.sentTotal - 1
    if (turn.sent.length > BRIDGE_LIMITS.replyChunks) {
      turn.sent.shift()
      turn.sentKinds.shift()
      turn.sentAts.shift()
      turn.sentTruncated = true
      this.counts.replyChunksDropped++
    }
    // The time of the last chunk he heard, for a deep turn's keep-alive.
    turn.lastSentAt = this.now()
    // The cue words said in this turn (a state's words are never said twice in a turn).
    if (kind === 'cue') { turn.cue = cue; turn.cues = (turn.cues ?? 0) + 1; if (!(turn.cuesSaid ??= []).includes(content)) turn.cuesSaid.push(content) } else {
      turn.spoken = true
      turn.carriedQuiet = false
      this.clearBackchannel(turn)
      const working = turn.path === 'fast' && turn.fast?.status === 'running' && !turn.fast.answered
      if (turn.deep && working) this.keepAlive(record, turn)
      // Her words re-arm the work cue while her fast turn still works.
      else if (working) this.armWorkCue(record, turn)
    }
    if (kind === 'hers') {
      // Words of the current model call were released as hers (cues never count).
      if (turn.path === 'fast' && turn.fast) turn.fast.answering = true
      // Once more than ANSWER_MIN_WORDS of this call are spoken it is an answer, and it covers the entry the
      // model has read (never words he added that it has not read yet). A turn her tab speaks is marked when it is done
      // (finish): until then his words stay open, as before.
      if (turn.path === 'fast' && turn.fast && turn.handedAt === undefined && !turn.fast.calling) {
        turn.fast.callWords = (turn.fast.callWords ?? 0) + plainWords(content).length
        if (turn.fast.callWords > ANSWER_MIN_WORDS) turn.answered = turn.read
      }
      turn.firstWordsAt ??= this.now()
      // Everything she said in the turn, up to the words record's cap (the prompt and the tab cut it again).
      if (turn.said.length < MEMORY_LIMITS.saidChars) turn.said = cutWords(turn.said + content, MEMORY_LIMITS.saidChars)
    }
    this.send(record.provider, this.adapter.chunk(turn.eventId, content))
  }

  /** Drop text after a refusal that was cut: up to the end of its clause (outside any code span), or to the next block,
   * which is refused whole by its own rule. True: the rest is ready to be read normally. */
  discardTo(turn, final) {
    const text = turn.pending
    const opener = findBlockOpener(text, final)
    const limit = opener ? (opener.wait ?? opener.index) : text.length
    const head = text.slice(0, limit)
    const found = clauseEnd(head, turn.discard.state)
    if (found.end !== -1) { turn.pending = text.slice(found.end); turn.discard = null; return true }
    if (opener && opener.wait === undefined) { turn.pending = text.slice(opener.index); turn.discard = null; return true }
    if (final) { turn.pending = ''; turn.discard = null; return false }
    // No end yet: what was read is dropped; a trailing sentence mark (it may end the clause with the next space) stays.
    const mark = found.state === 0 ? (/[.!?…]+["'’”)]*$/.exec(head)?.[0] ?? '') : ''
    turn.discard.state = found.state
    turn.pending = mark + text.slice(limit)
    return false
  }

  /** Her gathered text: tags stripped, cut into clauses, each judged by the existing clause rules; refused ones dropped.
   * A ``` fence or a `{`/JSON `[` block is never cut into lines: from the start of the clause that opens it to its close
   * (across any number of deltas, or to `done`) it is ONE refused unit, dropped and counted once. A clause the cap cut
   * that is refused holds its refusal to the end of its token and clause. */
  flush(record, turn, final) {
    turn.pending = stripFieldTags(turn.pending)
    for (;;) {
      if (turn.discard) {
        if (this.discardTo(turn, final)) continue
        break
      }
      if (turn.block) {
        const end = turn.block.kind === 'fence' ? turn.pending.indexOf('```') : scanNest(turn.block, turn.pending)
        if (end === -1) {
          // Still open: nothing of it is kept but a backtick tail that may be half of the closing fence.
          turn.pending = !final && turn.block.kind === 'fence' ? (/`{1,2}$/.exec(turn.pending)?.[0] ?? '') : ''
          if (final) { turn.block = null; this.counts.clausesDropped++ }
          break
        }
        turn.pending = turn.pending.slice(turn.block.kind === 'fence' ? end + 3 : end)
        turn.block = null
        turn.blockTail = true
        this.counts.clausesDropped++
        continue
      }
      const opener = findBlockOpener(turn.pending, final)
      if (turn.blockTail) {
        // The rest of the clause the block closed in belongs to it too: dropped up to the clause's end (uncounted).
        const limit = opener ? (opener.wait ?? opener.index) : turn.pending.length
        const tail = nextClause(turn.pending.slice(0, limit), final && !opener)
        if (tail) { turn.pending = tail[1] + turn.pending.slice(limit); turn.blockTail = false; continue }
        if (opener && opener.wait === undefined) { turn.blockTail = false; continue }
        if (final) { turn.pending = ''; turn.blockTail = false }
        break
      }
      if (opener === null) {
        turn.pending = this.speakClauses(record, turn, turn.pending, final, true)
        if (turn.discard) continue
        break
      }
      const at = opener.wait ?? opener.index
      // No early cut here: the unfinished clause before a block (or a tail that may open one) stays with it.
      const before = this.speakClauses(record, turn, turn.pending.slice(0, at), false)
      if (turn.discard || opener.wait !== undefined) { turn.pending = before + turn.pending.slice(at); if (turn.discard) continue; break }
      // The unfinished clause before the opener belongs to the refused block.
      turn.block = opener.kind === 'fence' ? { kind: 'fence' } : { kind: 'nest', depth: 0, inString: false, escape: false }
      turn.pending = turn.pending.slice(opener.kind === 'fence' ? at + 3 : at)
    }
    if (final) Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
  }

  /** Speak every whole clause of `text` that passes the rules; returns the unfinished rest ('' when final). A refused
   * clause that was cut mid-sentence (inside a token, at a space at the cap, or early at a `soft` boundary) starts a
   * discard to the end of its sentence, and the rest is returned. */
  speakClauses(record, turn, text, final, soft = false) {
    let rest = text
    for (let next = cutClause(rest, final, soft); next; next = cutClause(rest, final, soft)) {
      rest = next.rest
      if (!next.clause.trim()) continue
      // A 600-character token is not speech: refused without asking the rules.
      let refused = next.cut === 'token'
      // The hand-off tool's name or a tool-call shape is never speech; on a fast turn it is the hand-off.
      if (!refused && HAND_OFF_TEXT_RE.test(next.clause)) {
        refused = true
        // And his words are handed on: finished with here, as at the hand-off tool.
        if (turn.path === 'fast' && turn.fast && turn.handedAt === undefined) { turn.fast.handoff = true; turn.answered = turn.read }
      }
      if (!refused) {
        try { validateSpeakableClause({ turnId: turn.turnId, text: next.clause }) } catch { refused = true }
      }
      if (!refused) { this.say(record, turn, next.clause); continue }
      this.counts.clausesDropped++
      if (next.cut === 'space' || next.cut === 'token' || next.cut === 'soft') {
        turn.discard = { state: spanAfter(next.clause) }
        return rest
      }
    }
    return final ? '' : rest
  }

  /** Close a turn. `done`: her reply ended; the row is completed. `lost`: her tab went away after the turn was
   * journaled; the fixed sentence if nothing but (at most) the backchannel was said; the row is abandoned. `fail`: the
   * page said nothing for it; ONE true sentence for its `code` (FAIL_LINES; none for the owner's own cut); the row is
   * abandoned. */
  async finish(record, turn, how, code = '') {
    this.clearBackchannel(turn)
    this.stopFast(turn)
    turn.state = how === 'done' ? 'done' : 'abandoned'
    Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
    // A quiet handed turn speaks nothing more: a newer turn has the provider now.
    if (!turn.quiet) {
      if (how === 'lost' && !turn.spoken) this.say(record, turn, LOST_PLACE, 'fixed')
      if (how === 'fail' && !turn.spoken && !SILENT_FAIL_CODES.includes(code)) this.say(record, turn, Object.hasOwn(FAIL_LINES, code) ? FAIL_LINES[code] : LOST_PLACE, 'fixed')
      this.send(record.provider, this.adapter.final(turn.eventId))
    }
    // Her tab gone is `tab_lost`; a governed turn the page timed out is `turn_bound`.
    if (how === 'lost') turn.endReason ??= 'tab_lost'
    if (turn.fast?.limited) turn.endReason ??= 'tool_limit'
    await this.noteTurn(turn, how === 'done' ? 'done'
      : how === 'fail' && SILENT_FAIL_CODES.includes(code) ? 'cancelled'
        : how === 'fail' && (code === 'VOICE_TURN_TIMEOUT' || code === 'VOICE_TURN_CEILING') ? 'timeout' : 'failed')
    await this.terminalWrite(record, how === 'done' ? { action: 'complete', turnId: turn.turnId } : { action: 'cancel', turnId: turn.turnId, reason: 'turn_abandon' })
    // A finished exchange becomes one record of her voice memory (fast path on only: with it off, the bridge
    // stores no words). A handed turn's record is written now, when its done arrives, with what was spoken (a quiet one:
    // its hand-off line only, marked as handed: its later words were never said).
    // A turn that is done answered everything it read (a short answer too; a turn her tab spoke, governed
    // or fallen back, is marked only here). A turn handed to her working self was marked at its hand-off line.
    if (how === 'done' && turn.said) turn.answered = turn.read
    if (how === 'done' && turn.said) {
      await this.keepExchange(record, turn, turn.fast?.refused ? 'refused' : turn.fast?.handoff ? 'handed' : 'answered',
        turn.quiet ? `${cutWords(turn.said, MEMORY_LIMITS.saidChars - SPOKEN_HANDED.length)}${SPOKEN_HANDED}` : turn.said)
    }
    if (how !== 'done') await this.keepCutExchange(record, turn, 'failed')
  }

  /** Cancel a running turn: the local fence first (its later deltas are dropped at once), `cancel` to the tab (unless
   * `reason` is null, the tab having said bye), then the existing barge-in cancel in the journal. */
  async cancelTurn(record, turn, reason, journalReason) {
    this.clearBackchannel(turn)
    this.stopFast(turn)
    // Only a turn the tab was handed is cancelled there (a fast turn the tab never got is the bridge's own).
    const wasRunning = turn.state === 'running' && turn.handedAt !== undefined
    turn.state = 'cancelled'
    Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
    if (wasRunning && reason !== null) this.toTab(record, { t: 'cancel', turn: turn.turnId, reason })
    await this.noteTurn(turn, 'cancelled')
    await this.terminalWrite(record, { action: 'cancel', turnId: turn.turnId, reason: journalReason })
    await this.keepCutExchange(record, turn)
  }

  /** End a conversation: its running turn cancelled, the tab told `end` (unless it said bye), both sockets closed, every
   * timer of it cleared, its record removed, its live slot let go and its reservation trimmed to what it used. `ended`
   * is what the call history records: `reason`, or for a `bye` (reason null) the end the page named (BYE_ENDS). */
  async endConversation(record, reason, ended = reason ?? 'owner-stop', sdk = undefined) {
    if (record.ended) return
    record.ended = true
    for (const name of ['deadlineTimer', 'claimTimer']) if (record[name] !== undefined) { this.timers.clear(record[name]); record[name] = undefined }
    for (const item of record.turns.values()) this.clearBackchannel(item)
    const turn = record.turns.get(record.current)
    if (turn?.state === 'held') turn.state = 'superseded'
    if (turn && LIVE.has(turn.state)) {
      await this.cancelTurn(record, turn, reason, reason ?? 'turn_abandon')
      this.send(record.provider, this.adapter.final(turn.eventId))
    }
    for (const item of new Set(record.turns.values())) if (item.quiet && LIVE.has(item.state)) await this.cancelTurn(record, item, reason, reason ?? 'turn_abandon')
    if (reason && record.tab) this.toTab(record, { t: 'end', reason })
    const code = reason === 'unclaimed' ? 1008 : 1000
    this.close(record.tab, code)
    this.close(record.provider, code)
    this.convs.delete(record.conv)
    await this.endSlot(record.conv, ended, sdk)
  }
}
