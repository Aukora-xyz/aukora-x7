// HER GOVERNED VOICE TURN, FOR A TURN THE EDGE HANDS OVER.
//
// The edge has already journaled what the provider heard (voice-transcript-unconfirmed, no voice authority). This runs
// the same turn today's spoken path runs (aumalive.js transmit), minus that journal call: a question about herself is
// answered from her own index; anything else goes to `bridgedSpokenTurn` (genesis-live.js), which confirms her voice home
// look-only, puts the provenance marker first and the roster beside it, and prompts her in queue mode. Her text streams
// back through `say` with her `[field ...]` tags taken out (they move the field here and are never spoken); a sentence
// the page itself says for the turn (a refusal, a failed or silent turn) goes out the same way, as that turn's reply:
// the controller ends any turn that said something with `done`, so the edge speaks it. The code returned here is only
// sent (as `fail`) for a turn that said nothing.
//
// Every dependency is injected by aumalive.js, so nothing here holds a second copy of genesis-live.js or self-index.js.
import { FAIL_CODES, MANAGED_VOICE, TURN_LINES } from './policy.mjs'

/** The `done` reason genesis-live.js gives a turn it did not send because look-only was not confirmed. */
const LOOK_ONLY_REFUSED = 'voice-look-only-refused'

/** Her line after the provider cut her off: what she had actually said, and a mark where she stopped. */
export function markCut(corrected) {
  const said = String(corrected ?? '').replace(/\s+/g, ' ').trim()
  return said ? `${said} —` : '— (cut before she spoke)'
}

const plain = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
/** The first characters two texts are compared on: enough to tell one of her answers from another. */
const CORRECTION_PREFIX = 40

/**
 * Whether a provider correction (`agent_response_correction`) belongs to this line of hers: the line must begin as the
 * provider's original response begins (the corrected text, what was actually said, is only used when the provider sent
 * no original: it is a prefix of many lines). A correction for a line she never wrote here (the edge's own "one sec"
 * while a turn is slow) matches none of her lines and is dropped.
 */
export function correctionMatches(lineText, original, corrected) {
  const line = plain(lineText)
  const other = plain(original) || plain(corrected)
  const k = Math.min(CORRECTION_PREFIX, line.length, other.length)
  return k > 0 && line.slice(0, k) === other.slice(0, k)
}

/**
 * @param {object} deps
 * @param {(turn: object) => Promise<{ reason: string, text?: string, message?: string }>} deps.bridged  genesis-live.js bridgedSpokenTurn
 * @param {{ classify: Function, gather: Function, answer: Function, render: Function, wouldDelete: Function } | null} [deps.selfQuestion]
 * @param {(text: string) => string} deps.sanitize  aumalive.js sanitizeForVoice
 * @param {() => { push: (text: string) => string, flush: () => string }} deps.directives  a fresh [field ...] filter per turn
 * @param {(turnId: string, text: string, final: boolean) => void} [deps.onHer]  her line in the transcript
 * @param {(turnId: string) => void} [deps.onFirstText]  her first words of the turn
 * @param {() => string} [deps.mind]  the mind picker's choice
 * @param {() => Promise<string>} [deps.voiceLevel]  the worker's voice level (genesis-live.js voiceLevel); at 'open' the
 *   self-question shortcut is off and every spoken turn goes to her, under the open watchdog (MANAGED_VOICE.openFirstEventMs,
 *   openIdleMs, openTurnMs) instead of the 18 s / 22 s one, and the turn asks the controller to carry it past the call's
 *   end (`carry`): her work is never cut because the call ended, only by the owner's interruption or Stop.
 */
export function createGovernedTurnRunner({
  bridged, selfQuestion = null, sanitize = text => String(text ?? '').trim(), directives,
  onHer = () => {}, onFirstText = () => {}, mind = () => '', timers = globalThis, voiceLevel = null,
}) {
  const readLevel = typeof voiceLevel === 'function' ? voiceLevel : async () => 'unknown'
  return async function runTurn({ turnId, transcript, signal, say, carry = () => {}, council = false }) {
    const cancelled = { ok: false, code: FAIL_CODES.cancelled }
    // A sentence the page says for this turn: spoken through the call, and her line in the transcript.
    const sayLine = (line, before = '') => {
      say(line)
      onHer(turnId, before ? `${before} ${line}` : line, true)
    }

    // VOICE LEVEL open: no answer is built for her from an index in code; every spoken turn goes to her own mind.
    let level = 'unknown'
    if (selfQuestion || voiceLevel) {
      try { level = await readLevel() } catch { level = 'unknown' }
      if (signal.aborted) return cancelled
    }
    const open = level === 'open'
    // At open her turn outlives the call: if the call ends while she works, her answer still lands in her thread.
    if (open) { try { carry() } catch { /* the controller keeps its own state */ } }
    const ask = open ? null : selfQuestion?.classify(transcript) ?? null
    if (ask) {
      let answer
      try {
        answer = selfQuestion.answer(ask, await selfQuestion.gather(ask, { signal }))
      } catch (error) {
        if (signal.aborted) return cancelled
        answer = selfQuestion.answer(ask, { indexError: error instanceof Error ? error.message : String(error) })
      }
      if (signal.aborted) return cancelled
      // 'pass': her index did not answer, so this is doubt, not an answer; she takes the turn as any turn.
      if (answer?.status !== 'pass') {
        const spoken = selfQuestion.render(answer, 'spoken')
        onFirstText(turnId)
        say(selfQuestion.wouldDelete(spoken) ? TURN_LINES.selfTooLong : spoken)
        onHer(turnId, selfQuestion.render(answer, 'written'), true)
        return { ok: true }
      }
    }

    const filter = directives()
    const local = new AbortController()
    const forward = () => local.abort(signal.reason)
    if (signal.aborted) local.abort(signal.reason)
    else signal.addEventListener('abort', forward, { once: true })
    // The watchdog: the first sign of life, then the longest quiet between two events (each event re-arms it), and at
    // open one ceiling for the whole turn. Her session's activity (every follow frame, tools included) is an event.
    const firstMs = open ? MANAGED_VOICE.openFirstEventMs : MANAGED_VOICE.firstEventMs
    const idleMs = open ? MANAGED_VOICE.openIdleMs : MANAGED_VOICE.idleMs
    let quietTimer = null
    let quiet = false
    let ceiling = false
    const arm = ms => {
      timers.clearTimeout(quietTimer)
      quietTimer = timers.setTimeout(() => { quiet = true; local.abort(new Error('quiet')) }, ms)
    }
    const ceilingTimer = open
      ? timers.setTimeout(() => { ceiling = true; local.abort(new Error('ceiling')) }, MANAGED_VOICE.openTurnMs)
      : null
    let full = ''
    let started = false
    const take = visible => {
      if (!visible || local.signal.aborted) return
      full += visible
      if (!full.trim()) return
      if (!started) { started = true; onFirstText(turnId); say(full.trimStart()) } else say(visible)
      onHer(turnId, sanitize(full), false)
    }
    arm(firstMs)
    let result
    try {
      result = await bridged({
        // A turn the edge marked as his ask for the council (genesis-live.js VOICE_COUNCIL_PART).
        turnId, transcript, council: council === true, signal: local.signal, mind: mind(),
        onActivity: () => { if (!local.signal.aborted) arm(idleMs) },
        onToken: value => {
          if (local.signal.aborted) return
          arm(idleMs)
          take(filter.push(value))
        },
      })
    } catch (error) {
      result = { reason: local.signal.aborted ? 'aborted' : 'stream-failed', message: error instanceof Error ? error.message : String(error) }
    } finally {
      timers.clearTimeout(quietTimer)
      timers.clearTimeout(ceilingTimer)
      signal.removeEventListener('abort', forward)
    }
    if (signal.aborted) {
      // Cut: what she had said stays in the transcript; nothing more is said.
      if (full.trim()) onHer(turnId, sanitize(full), true)
      return cancelled
    }
    if (quiet || ceiling) {
      const line = ceiling ? TURN_LINES.ceiling : TURN_LINES.quiet
      const code = ceiling ? FAIL_CODES.ceiling : FAIL_CODES.timeout
      // At open, a turn that said nothing yet ends in `fail` with its code: the edge speaks the one line for it (the same
      // words) and records the turn as a timeout. At any other level, and after any of her words, the page says it.
      if (open && !full.trim()) {
        onHer(turnId, line, true)
        return { ok: false, code }
      }
      sayLine(line, full.trim() ? sanitize(full) : '')
      return { ok: false, code }
    }
    take(filter.flush())
    if (result?.reason === LOOK_ONLY_REFUSED) {
      // genesis-live.js has handed the refusal sentence to onToken already: it was said and shown. She was not prompted.
      if (!full.trim() && typeof result.message === 'string' && result.message.trim()) sayLine(result.message.trim())
      else onHer(turnId, sanitize(full), true)
      return { ok: false, code: FAIL_CODES.lookOnly }
    }
    if (full.trim()) {
      onHer(turnId, sanitize(full), true)
      return { ok: true }
    }
    if (result?.reason === 'voice-turn-invalid') return { ok: false, code: FAIL_CODES.invalid }
    const message = typeof result?.message === 'string' ? sanitize(result.message).slice(0, 300) : ''
    const line = result?.reason === 'stream-failed'
      ? TURN_LINES.flicker
      : result?.reason === 'record-failed'
        ? TURN_LINES.recordFailed
        : message ? `The live channel failed: ${message}` : TURN_LINES.noWords
    sayLine(line)
    return { ok: false, code: FAIL_CODES.failed }
  }
}

/** Everything up to the last finished sentence (., !, ? or an ellipsis, maybe closed by a quote or bracket), or ''. */
const wholeSentences = text => (String(text).match(/^[\s\S]*[.!?…]["'’”)\]]?(?=\s|$)/)?.[0] ?? '').trim()

/**
 * The call's first words from what she wrote: whitespace folded; a turn cut at the deadline (or one that failed) keeps
 * only the sentences she finished; then at most MANAGED_VOICE.openingCodePoints, cut at a sentence end when there is one.
 */
export function openingWords(text, partial = false) {
  let words = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (partial) words = wholeSentences(words)
  const points = Array.from(words)
  if (points.length <= MANAGED_VOICE.openingCodePoints) return words
  const head = points.slice(0, MANAGED_VOICE.openingCodePoints).join('')
  return wholeSentences(head) || head.trim()
}

/**
 * HER FIRST WORDS WHEN THE OWNER OPENS THE VOICE (2026-11-14; docs/auma/managed-voice.md). Runs her arrival turn
 * (`arrive`: genesis-live.js arrivalTurn, which only speaks at level open) and answers with what she wrote, her
 * `[field ...]` tags applied to the field and taken out, cleaned for the ear. Cut by the press's signal (the deadline,
 * Stop, or an answer that is not a call), it answers at once with the sentences she had finished. Never throws.
 * @param {object} deps
 * @param {(turn: object) => Promise<{ reason: string, text?: string }>} deps.arrive
 * @param {(text: string) => string} [deps.sanitize]  aumalive.js sanitizeForVoice
 * @param {() => { push: (text: string) => string, flush: () => string }} deps.directives  a fresh [field ...] filter
 * @param {() => string} [deps.mind]  the mind picker's choice
 */
export function createArrivalRunner({ arrive, sanitize = text => String(text ?? '').trim(), directives, mind = () => '' }) {
  return async function arrival({ signal }) {
    const filter = directives()
    let full = ''
    let open = true
    const take = value => { if (open) full += filter.push(value) }
    const cut = new Promise((resolve) => {
      if (signal.aborted) resolve('cut')
      else signal.addEventListener('abort', () => resolve('cut'), { once: true })
    })
    let partial = true
    try {
      const run = Promise.resolve().then(() => arrive({ signal, mind: mind(), onToken: take })).catch(() => null)
      const outcome = await Promise.race([run, cut])
      if (outcome !== 'cut' && !signal.aborted) {
        full += filter.flush()
        partial = outcome?.reason !== 'completed'
      }
    } finally {
      open = false
    }
    let clean = ''
    try { clean = sanitize(full) } catch { clean = '' }
    return openingWords(clean, partial)
  }
}
