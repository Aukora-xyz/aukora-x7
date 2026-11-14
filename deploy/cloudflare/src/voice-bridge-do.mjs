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
 * Her streamed text comes back as `delta` frames; it is gathered into clauses (an inline code span is never split),
 * `[field ...]` tags are stripped, and each clause must pass the EXISTING speakable-clause rules (voice-director.mjs
 * validateSpeakableClause) before it goes to the provider. A refused clause is dropped and counted, never sent, and when
 * it was cut (the 600-character cap) the refusal holds to the end of its token and clause.
 * Terminal journal writes (complete, cancel, abandon) are retried (5 tries, spaced) and counted; while a cancel is
 * unconfirmed the next turn of that conversation waits, and if it stays unconfirmed the conversation ends.
 * Every socket event, timer and admission call runs one at a time (`serial`), so a turn's journal write, its cancel and
 * its deltas are never interleaved. The slow-reply backchannel alone runs on its own clock (it only reads state).
 */

import { validateSpeakableClause, idleVoiceDirective, VOICE_CLAUSE_MAX_CHARS } from './voice-director.mjs'
import { VOICE_BRIDGE_PROTOCOL, VOICE_FAILURE_STAGES } from './voice-bridge.mjs'
// The closed lists of the history (VOICE_CALL_ENDS, VOICE_TURN_OUTCOMES) live in voice-bridge.mjs, beside the status read.
import { VOICE_CONNECT_GRACE_MS, VOICE_CONNECT_WINDOW_MS, VOICE_MINT_WINDOW_MS, VOICE_SESSION_LIMITS, admissionPeriods, validDurationSeconds } from './voice-session-policy.mjs'
import { CONVERSATION_ID_RE, EVENT_ID_MAX, PROVIDER_FRAME_MAX_BYTES, SPEECH_ENGINE_ADAPTER, SPEECH_ENGINE_TIMEOUT_SECONDS } from './voice-provider-speech-engine.mjs'

export const TAB_FRAME_MAX_BYTES = 8192
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
/** The one allowed backchannel (voice-director.mjs's list), with the provider's documented buffer suffix. */
export const BACKCHANNEL = `${idleVoiceDirective().allowedBackchannels.find(item => item === 'one sec')}... `
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
/**
 * WHY A CALL OR A TURN ENDED (2026-11-14), for the owner's status read. Closed values and numbers only: never a
 * transcript, a conversation id or a turn id. The last 4 calls and the last 8 turns are kept.
 *   call `ended`: deadline | provider-closed | owner-stop (his Stop: a `bye` with why 'stop', or a bare `bye`)
 *     | unclaimed | journal-unavailable | error (a call the bridge lost track of: its slot ran out with no end recorded)
 *   turn `outcome`: done | cancelled | timeout | failed | late-answer (done, but her first words reached the provider
 *     after its per-attempt wait, SPEECH_ENGINE_TIMEOUT_SECONDS: whether the provider still spoke them is its own)
 */
export const HISTORY_KEY = 'voice-bridge:history'
export const CALLS_KEPT = 4
export const TURNS_KEPT = 8
const wholeSeconds = ms => Math.max(0, Math.ceil(ms / 1000))

const HEX_64 = /^[0-9a-f]{64}$/
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

/** One tab frame, closed shapes only (each at most 8 KiB of text); null closes the socket. */
export function parseTabFrame(data) {
  if (typeof data !== 'string' || encoder.encode(data).byteLength > TAB_FRAME_MAX_BYTES) return null
  let frame
  try { frame = JSON.parse(data) } catch { return null }
  if (!isObject(frame)) return null
  const turnOk = value => typeof value === 'string' && BRIDGE_TURN_ID_RE.test(value)
  switch (frame.t) {
    case 'hello': return exactKeys(frame, ['t', 'conv']) && typeof frame.conv === 'string' && CONVERSATION_ID_RE.test(frame.conv) ? frame : null
    case 'delta': return exactKeys(frame, ['t', 'turn', 'seq', 'text']) && turnOk(frame.turn) && Number.isSafeInteger(frame.seq) && frame.seq >= 0
      && frame.seq <= EVENT_ID_MAX && typeof frame.text === 'string' && frame.text.length <= TAB_TEXT_MAX_CHARS ? frame : null
    case 'done': return exactKeys(frame, ['t', 'turn']) && turnOk(frame.turn) ? frame : null
    case 'fail': return exactKeys(frame, ['t', 'turn', 'code']) && turnOk(frame.turn) && typeof frame.code === 'string' && FAIL_CODE_RE.test(frame.code) ? frame : null
    case 'bye': return exactKeys(frame, ['t']) || (exactKeys(frame, ['t', 'why']) && typeof frame.why === 'string' && Object.hasOwn(BYE_ENDS, frame.why)) ? frame : null
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

/** The next speakable clause of a turn's gathered text and how it was cut: at a clause end outside any code span
 * ('boundary'), at the clause cap on a space ('space') or inside one long token ('token'), or the tail at `done`
 * ('final'). An unterminated `[field` tag at the tail waits for its `]`. Null: wait for more. */
export function cutClause(pending, final) {
  const open = pending.search(/\[field\b[^\]]*$/)
  const usable = open === -1 ? pending : pending.slice(0, open)
  const window = usable.slice(0, VOICE_CLAUSE_MAX_CHARS)
  const { end } = clauseEnd(window)
  if (end !== -1) return { clause: usable.slice(0, end), rest: pending.slice(end), cut: 'boundary' }
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
    }
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
    for (const [id, slot] of Object.entries(record.slots)) {
      if (slot.until > at || (ending !== null && slot.conv === ending)) continue
      delete record.slots[id]
      // A call that was claimed (hello) and ran out with no end recorded: the bridge lost track of it. Its seconds stay
      // spent (it may have run to the end). A minted call nobody claimed keeps its reservation as before.
      if (slot.conv !== null && Number.isSafeInteger(slot.helloAt)) {
        await this.pushHistory(tx, 'calls', { grantedSeconds: slot.seconds, ended: 'error', lastedSeconds: Math.min(slot.seconds, wholeSeconds(slot.until - slot.helloAt)), atMs: slot.until })
      }
    }
    return record
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
    return await this.state.storage.transaction(async tx => {
      const record = await this.readAdmission(tx, at)
      const slot = typeof input.slot === 'string' ? record.slots[input.slot] : undefined
      let answer
      if (input.action === 'reserve') {
        // `seconds` is the most one call may want; what is reserved is that, or what is left of the day and the month.
        const most = validDurationSeconds(input.seconds)
        if (most === null) return { ok: false, code: 'VOICE_ADMIT_INVALID' }
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
    return { ok: true, live, failures, calls: listed('calls'), turns: listed('turns'), secondsLeft }
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
  async endSlot(conv, ended) {
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
        await this.pushHistory(tx, 'calls', { grantedSeconds: slot.seconds, ended, lastedSeconds: Math.min(slot.seconds, wholeSeconds(at - (slot.helloAt ?? startedAt))), atMs: at })
      }
      await tx.put(ADMISSION_KEY, record)
    })
  }

  /** One finished turn of hers onto the history: its outcome, seconds to her first words, its longest quiet. */
  async noteTurn(turn, outcome) {
    if (turn.noted) return
    turn.noted = true
    const at = this.now()
    const quiet = Math.max(turn.longestQuietMs ?? 0, at - (turn.lastAt ?? turn.arrivedAt))
    const entry = {
      outcome,
      firstWordsSeconds: Number.isSafeInteger(turn.firstWordsAt) ? wholeSeconds(turn.firstWordsAt - turn.arrivedAt) : null,
      longestQuietSeconds: wholeSeconds(quiet),
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
   * would put more than 64 KiB behind the frame in hand, closes the socket before anything else is done with it. */
  listen(peer, onMessage, onGone) {
    peer.socket.addEventListener('message', event => {
      if (peer.closed) return
      const data = event.data
      const size = typeof data === 'string' ? utf8Bytes(data) : (Number.isSafeInteger(data?.byteLength) ? data.byteLength : 0)
      if (size > peer.frameMax || (peer.queued > 0 && peer.queued + size > BRIDGE_LIMITS.queuedBytes)) {
        if (size <= peer.frameMax) this.counts.queueOverflows++
        this.close(peer, 1008)
        void this.serial(() => onGone(peer))
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
    const tab = this.open(server, TAB_FRAME_MAX_BYTES)
    if (tab) {
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
      provider.waitTimer = this.timers.set(() => { void this.serial(async () => {
        if (provider.conv !== null || provider.closed) return
        this.close(provider, 1008)
        await this.noteFailure('provider', 'init-timeout', this.now()).catch(() => null)
      }) }, INIT_WAIT_MS)
      this.listen(provider, (peer, data, arrivedAt) => this.onProvider(peer, data, arrivedAt), peer => this.providerGone(peer))
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  record(conv, slot) {
    let record = this.convs.get(conv)
    if (!record) {
      record = { conv, seedId: slot.seedId, seconds: slot.seconds, tab: null, provider: null, turns: new Map(), current: null, ended: false,
        deadlineTimer: undefined, claimTimer: undefined }
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
    if (frame.t === 'bye') return await this.endConversation(record, null, frame.why === undefined ? 'owner-stop' : BYE_ENDS[frame.why])
    const turn = [...record.turns.values()].find(item => item.turnId === frame.turn)
    if (!turn || turn.state !== 'running') { this.counts.deltasDropped++; return }
    if (frame.t === 'delta') {
      if (frame.seq !== turn.seq) return await this.rejectTab(tab)
      turn.seq++
      const at = this.now()
      turn.longestQuietMs = Math.max(turn.longestQuietMs ?? 0, at - (turn.lastAt ?? turn.arrivedAt))
      turn.lastAt = at
      turn.pending += frame.text
      if (turn.pending.length * 3 > BRIDGE_LIMITS.pendingBytes && utf8Bytes(turn.pending) > BRIDGE_LIMITS.pendingBytes) {
        // Over the bound: everything gathered is dropped, and so is the rest of the clause it was in.
        turn.pending = ''
        this.counts.clausesDropped++
        this.counts.pendingOverflows++
        if (!turn.block) turn.discard = { state: 0 }
      }
      return this.flush(record, turn, false)
    }
    if (frame.t === 'done') {
      this.flush(record, turn, true)
      return await this.finish(record, turn, 'done')
    }
    // `fail`: the page said nothing for this turn. Abandoned; one true sentence for its code (none for the owner's cut).
    await this.finish(record, turn, 'fail', frame.code)
  }

  async hello(tab, conv) {
    const slot = await this.slotFor(conv, tab.owner)
    if (!slot || tab.closed) return this.close(tab, 1008)
    if (tab.waitTimer !== undefined) { this.timers.clear(tab.waitTimer); tab.waitTimer = undefined }
    this.waiting.delete(tab)
    const record = this.record(conv, slot)
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
    this.awaitTab(record)
  }

  // ── The provider door ────────────────────────────────────────────────────────────────────────────────────────────
  async onProvider(provider, data, arrivedAt) {
    if (provider.closed) return
    const event = this.adapter.parse(data)
    if (!event) {
      this.close(provider, 1008)
      return await this.providerGone(provider)
    }
    if (event.kind === 'init') return await this.init(provider, event.conv)
    if (event.kind === 'ping') return void this.send(provider, this.adapter.pong(event.eventId))
    if (event.kind === 'error') { this.counts.providerErrors++; return }
    if (provider.conv === null) return this.close(provider, 1008)
    const record = this.convs.get(provider.conv)
    if (!record || record.provider !== provider) return this.close(provider, 1008)
    if (event.kind === 'close') { this.close(provider, 1000); return await this.providerLost(record) }
    await this.transcript(record, event.eventId, event.text, arrivedAt)
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
  async transcript(record, eventId, text, arrivedAt) {
    if (record.ended) return
    if (record.current !== null && eventId < record.current) { this.counts.staleEvents++; return }
    if (record.current === eventId) return this.replay(record, eventId)
    const older = record.turns.get(record.current)
    record.current = eventId
    if (older?.state === 'held') older.state = 'superseded'
    else if (older && LIVE.has(older.state)) await this.cancelTurn(record, older, 'superseded', 'barge_in')
    const turn = { eventId, turnId: `eleven:${record.conv}:${eventId}`, transcript: text, arrivedAt, state: 'held', seq: 0, pending: '',
      block: null, blockTail: false, discard: null, sent: [], sentTruncated: false, spoken: false, backchannelTimer: undefined }
    record.turns.set(eventId, turn)
    for (const key of [...record.turns.keys()].slice(0, Math.max(0, record.turns.size - TURN_MEMORY))) record.turns.delete(key)
    if (record.ended) return
    if (!text) {
      // Empty, whitespace or over the limit: it still superseded the older turn; it gets the empty final only.
      turn.state = 'refused'
      this.counts.transcriptsRefused++
      this.send(record.provider, this.adapter.final(eventId))
      return
    }
    await this.advance(record)
  }

  /** The provider retried the newest event: a turn still waiting or running is re-attached (nothing new starts); a
   * finished one is replayed from its kept chunks, or answered with the empty final when they are not all kept. */
  replay(record, eventId) {
    const turn = record.turns.get(eventId)
    if (!turn || turn.state === 'held' || LIVE.has(turn.state)) return
    if ((turn.state === 'done' || turn.state === 'abandoned') && turn.sent.length && !turn.sentTruncated) {
      this.send(record.provider, this.adapter.chunk(eventId, turn.sent.join('')))
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
    const journaled = await this.journal(record.seedId, { turnId: turn.turnId, provider: 'eleven-managed-voice', endpoint: '/door/voice-brain',
      requestedModel: null, ...await this.envelope(turn), modality: 'voice', voiceId: null })
    if (turn.state !== 'journaling') return
    if (journaled.ok !== true) {
      turn.state = 'unjournaled'
      this.counts.unjournaled++
      await this.noteTurn(turn, 'failed')
      this.send(record.provider, this.adapter.final(turn.eventId))
      this.toTab(record, { t: 'cancel', turn: turn.turnId, reason: 'unjournaled' })
      return
    }
    turn.state = 'running'
    if (!record.tab) return await this.finish(record, turn, 'lost')
    this.toTab(record, { t: 'turn', turn: turn.turnId, eventId: turn.eventId, transcript: turn.transcript })
    // The backchannel's deadline counts from the transcript's ARRIVAL; what is left is computed now, after the waits.
    const wait = turn.arrivedAt + SPEECH_ENGINE_TIMEOUT_SECONDS * 1000 - BACKCHANNEL_LEAD_MS - this.now()
    if (wait <= 0) this.backchannel(record, turn)
    else turn.backchannelTimer = this.timers.set(() => { turn.backchannelTimer = undefined; this.backchannel(record, turn) }, wait)
  }

  /** The one allowed backchannel, once, for a running turn that has said nothing. Runs on its own clock, not behind
   * other work: it only reads the turn's state and sends one frame. */
  backchannel(record, turn) {
    if (turn.state === 'running' && !turn.sent.length && !record.ended) this.say(record, turn, BACKCHANNEL, 'backchannel')
  }

  clearBackchannel(turn) {
    if (turn.backchannelTimer !== undefined) { this.timers.clear(turn.backchannelTimer); turn.backchannelTimer = undefined }
  }

  /** The journal row: hashes and the byte count only. What the owner says is never stored by the bridge (they reach the
   * page in the `turn` frame; nothing reads them back from the journal). */
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

  /** Text that already passed the rules (or the fixed sentence / backchannel) goes to the provider as one chunk. Only
   * real words mark the turn as spoken: the backchannel alone does not. Only HER words (`kind` 'hers') set the time of
   * her first words: the edge's own fixed sentence ('fixed': LOST_PLACE, a FAIL_LINES line) never does. At most 256
   * chunks are kept for a retry. */
  say(record, turn, content, kind = 'hers') {
    turn.sent.push(content)
    if (turn.sent.length > BRIDGE_LIMITS.replyChunks) {
      turn.sent.shift()
      turn.sentTruncated = true
      this.counts.replyChunksDropped++
    }
    if (kind !== 'backchannel') turn.spoken = true
    if (kind === 'hers') turn.firstWordsAt ??= this.now()
    this.clearBackchannel(turn)
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
        turn.pending = this.speakClauses(record, turn, turn.pending, final)
        if (turn.discard) continue
        break
      }
      const at = opener.wait ?? opener.index
      const before = this.speakClauses(record, turn, turn.pending.slice(0, at), false)
      if (turn.discard || opener.wait !== undefined) { turn.pending = before + turn.pending.slice(at); if (turn.discard) continue; break }
      // The unfinished clause before the opener belongs to the refused block.
      turn.block = opener.kind === 'fence' ? { kind: 'fence' } : { kind: 'nest', depth: 0, inString: false, escape: false }
      turn.pending = turn.pending.slice(opener.kind === 'fence' ? at + 3 : at)
    }
    if (final) Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
  }

  /** Speak every whole clause of `text` that passes the rules; returns the unfinished rest ('' when final). A refused
   * clause that the cap cut (inside a token, or at a space mid-clause) starts a discard, and the rest is returned. */
  speakClauses(record, turn, text, final) {
    let rest = text
    for (let next = cutClause(rest, final); next; next = cutClause(rest, final)) {
      rest = next.rest
      if (!next.clause.trim()) continue
      // A 600-character token is not speech: refused without asking the rules.
      let refused = next.cut === 'token'
      if (!refused) {
        try { validateSpeakableClause({ turnId: turn.turnId, text: next.clause }) } catch { refused = true }
      }
      if (!refused) { this.say(record, turn, next.clause); continue }
      this.counts.clausesDropped++
      if (next.cut === 'space' || next.cut === 'token') {
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
    turn.state = how === 'done' ? 'done' : 'abandoned'
    Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
    if (how === 'lost' && !turn.spoken) this.say(record, turn, LOST_PLACE, 'fixed')
    if (how === 'fail' && !turn.spoken && !SILENT_FAIL_CODES.includes(code)) this.say(record, turn, Object.hasOwn(FAIL_LINES, code) ? FAIL_LINES[code] : LOST_PLACE, 'fixed')
    this.send(record.provider, this.adapter.final(turn.eventId))
    const late = Number.isSafeInteger(turn.firstWordsAt) && turn.firstWordsAt - turn.arrivedAt > SPEECH_ENGINE_TIMEOUT_SECONDS * 1000
    await this.noteTurn(turn, how === 'done' ? (late ? 'late-answer' : 'done')
      : how === 'fail' && SILENT_FAIL_CODES.includes(code) ? 'cancelled'
        : how === 'fail' && (code === 'VOICE_TURN_TIMEOUT' || code === 'VOICE_TURN_CEILING') ? 'timeout' : 'failed')
    await this.terminalWrite(record, how === 'done' ? { action: 'complete', turnId: turn.turnId } : { action: 'cancel', turnId: turn.turnId, reason: 'turn_abandon' })
  }

  /** Cancel a running turn: the local fence first (its later deltas are dropped at once), `cancel` to the tab (unless
   * `reason` is null, the tab having said bye), then the existing barge-in cancel in the journal. */
  async cancelTurn(record, turn, reason, journalReason) {
    this.clearBackchannel(turn)
    const wasRunning = turn.state === 'running'
    turn.state = 'cancelled'
    Object.assign(turn, { pending: '', block: null, blockTail: false, discard: null })
    if (wasRunning && reason !== null) this.toTab(record, { t: 'cancel', turn: turn.turnId, reason })
    await this.noteTurn(turn, 'cancelled')
    await this.terminalWrite(record, { action: 'cancel', turnId: turn.turnId, reason: journalReason })
  }

  /** End a conversation: its running turn cancelled, the tab told `end` (unless it said bye), both sockets closed, every
   * timer of it cleared, its record removed, its live slot let go and its reservation trimmed to what it used. `ended`
   * is what the call history records: `reason`, or for a `bye` (reason null) the end the page named (BYE_ENDS). */
  async endConversation(record, reason, ended = reason ?? 'owner-stop') {
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
    if (reason && record.tab) this.toTab(record, { t: 'end', reason })
    const code = reason === 'unclaimed' ? 1008 : 1000
    this.close(record.tab, code)
    this.close(record.provider, code)
    this.convs.delete(record.conv)
    await this.endSlot(record.conv, ended)
  }
}
