/**
 * seed-voice-slot — compiles the organism's state into one bounded, spoakable attention sink.
 *
 * The mouth (PersonaPlex) has a 2,048-frame window, no tools, and no access to receipts, DAG, carrier
 * files or passkeys. Left alone it will confabulate organism state with total acoustic confidence.
 * So the mouth never gets the organism; it gets <= 1,200 UTF-8 bytes of plain prose, compiled here,
 * deterministic, from text that was already trusted.
 *
 * Invariants enforced at emit, not documented in a comment:
 *   - the slot is <= 1200 UTF-8 bytes and is NEVER truncated mid-codepoint; if it cannot fit it refuses
 *   - the slot carries zero 40..64 hex runs, zero JSON, zero secret prefixes, zero stack traces
 *   - every clause handed to the mouth is <= 600 chars and passes validateSpeakableClause
 *   - voiceAuthority is 'none' and idle turns may emit only backchannels
 */

export const VOICE_SLOT_SCHEMA = 'aukora.voice-slot.v1'
export const STATE_SLOT_MAX_BYTES = 1200
export const MAX_CLAUSE_CHARS = 600
/** Inline code is only tolerated as a short bare token (a voice id, a name). Anything longer is a dump. */
export const INLINE_CODE_WINDOW = 40
export const PINNED_VOICES = Object.freeze([
  'NATF0', 'NATF1', 'NATF2', 'NATF3', 'NATM0', 'NATM1', 'NATM2', 'NATM3',
  'VARF0', 'VARF1', 'VARF2', 'VARF3', 'VARM0', 'VARM1', 'VARM2', 'VARM3',
])
export const DEFAULT_PINNED_VOICE = 'VARF1'

const fail = (code, detail) => ({ ok: false, code, detail: detail === undefined ? null : detail })

// A clause may never carry material the mouth could read aloud with confidence in a voice it does not have.
const FORBIDDEN = Object.freeze([
  ['SECRET_PREFIX', /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/],
  ['PEM_MARKER', /-----BEGIN [A-Z0-9 ]+-----/],
  ['HEX_SHA', /\b[0-9a-f]{40,64}\b/i],
  ['STACK_TRACE', /(?:^|\n)\s*at\s+\S+\s*\(|Error:\s+.+\n\s+at\s+/],
  ['INLINE_JSON', /"[A-Za-z0-9_]+"\s*:\s*|[{[]\s*"[A-Za-z0-9_]+"\s*:/],
  ['RECEIPT_DUMP', /\b(?:seq|leafHash|prevHash|merkleRoot)\s*[:=]/i],
])

/**
 * A backtick span must be a short bare token. Pairing is counted, not guessed: an odd number of
 * backticks is markdown leakage and is refused outright. The window is bounded at INLINE_CODE_WINDOW
 * so one JSON example in a long sentence can no longer condemn the whole clause.
 * @param {string} text
 * @returns {string|null} the violation, or null when every span is a harmless bare token
 */
export function inlineCodeViolation(text) {
  const ticks = (String(text).match(/`/g) || []).length
  if (ticks % 2 === 1) return 'UNBALANCED_BACKTICK'
  const re = /`([^`]*)`/g
  let m
  while ((m = re.exec(String(text))) !== null) {
    const span = m[1]
    if ([...span].length > INLINE_CODE_WINDOW) return 'INLINE_CODE_TOO_LONG'
    if (/[{}]/.test(span)) return 'INLINE_CODE_BRACE'
    if (/(?:^|\s)\w+\s*=\s*\S/.test(span)) return 'INLINE_CODE_ASSIGN'
    if (/[;()]/.test(span)) return 'INLINE_CODE_SYNTAX'
  }
  return null
}

const utf8 = (s) => {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).byteLength
  return Buffer.byteLength(s, 'utf8')
}

/** Whether the mouth may say this clause at all. */
export function validateSpeakableClause(text) {
  if (typeof text !== 'string' || !text.trim()) return fail('CLAUSE_EMPTY')
  const bytes = utf8(text)
  if ([...text].length > MAX_CLAUSE_CHARS) return fail('CLAUSE_TOO_LONG', [...text].length)
  for (const [code, re] of FORBIDDEN) if (re.test(text)) return fail('CLAUSE_FORBIDDEN', code)
  const inline = inlineCodeViolation(text)
  if (inline) return fail('CLAUSE_FORBIDDEN', inline)
  return { ok: true, code: 'SPEAKABLE', chars: [...text].length, bytes }
}

/** While the brain is thinking, the mouth may only be quiet or phatic. */
export function idleVoiceDirective(reason) {
  return {
    ok: true,
    allowSubstantiveGeneration: false,
    mode: 'backchannel_only',
    reason: typeof reason === 'string' && reason ? reason : 'brain_busy',
    allowedUtterances: ['mm-hm', 'let me check', 'one moment', 'still working on it'],
    voiceAuthority: 'none',
  }
}

/** Split prose into mouth-sized clauses at sentence boundaries; never split a codepoint. */
export function splitClauses(text, max = MAX_CLAUSE_CHARS) {
  const clauses = []
  const parts = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean)
  let buf = ''
  const push = () => { if (buf) { clauses.push(buf); buf = '' } }
  for (const part of parts) {
    const candidate = buf ? buf + ' ' + part : part
    if ([...candidate].length <= max) { buf = candidate; continue }
    push()
    if ([...part].length <= max) { buf = part; continue }
    // a single over-long sentence: cut on whitespace inside the limit
    let rest = part
    while ([...rest].length > max) {
      const chars = [...rest]
      let cut = max
      while (cut > 0 && chars[cut] !== ' ') cut--
      if (cut === 0) cut = max
      clauses.push(chars.slice(0, cut).join('').trim())
      rest = chars.slice(cut).join('').trim()
    }
    buf = rest
  }
  push()
  return clauses.filter(Boolean)
}

/**
 * Compile the organism's state into the mouth's attention sink.
 * @param {{organism?: string, epoch?: number, ballId?: string, ballIdShort?: string,
 *          pinnedVoice?: string, facts?: string[], handoffText?: string, recallText?: string}} input
 * @returns {{ok: boolean, code: string, slot?: string, bytes?: number, facts?: string[], pinnedVoice?: string}}
 */
export function compileVoiceStateSlot(input) {
  const src = input !== null && typeof input === 'object' ? input : {}
  const voice = src.pinnedVoice === undefined ? DEFAULT_PINNED_VOICE : src.pinnedVoice
  if (!PINNED_VOICES.includes(voice)) return fail('VOICE_NOT_PINNED', String(voice))
  if (!Number.isSafeInteger(src.epoch) || src.epoch < 0) return fail('EPOCH_INVALID', String(src.epoch))

  const organism = typeof src.organism === 'string' && src.organism ? src.organism : 'Auma'
  const short = typeof src.ballIdShort === 'string' ? src.ballIdShort.slice(0, 8) : ''

  // facts are the only substantive content allowed, and each must be speakable on its own
  const factsIn = Array.isArray(src.facts) ? src.facts : []
  const facts = []
  for (const fact of factsIn.slice(0, 8)) {
    const one = splitClauses(String(fact))[0]
    if (!one) continue
    if (!validateSpeakableClause(one).ok) continue
    facts.push(one)
    if (facts.length === 4) break
  }

  const lines = []
  lines.push(organism + ' is live, at epoch ' + src.epoch + (short ? ', head ' + short : '') + '.')
  lines.push('She is speaking through a voice that has no authority: nothing spoken can approve anything.')
  if (facts.length) lines.push('What is true right now: ' + facts.join(' '))
  lines.push('If something needs the owner, she says so and waits for Touch ID on the Sovereignty card.')

  const slot = lines.join('\n')
  const bytes = utf8(slot)
  if (bytes > STATE_SLOT_MAX_BYTES) return fail('STATE_SLOT_UNCOMPILABLE', bytes)
  const bad = validateSpeakableClause(slot)
  if (bad.code === 'CLAUSE_TOO_LONG' || bad.code === 'CLAUSE_FORBIDDEN') return fail(bad.code, bad.detail)

  return { ok: true, code: 'COMPILED', schema: VOICE_SLOT_SCHEMA, slot, bytes, facts, pinnedVoice: voice, voiceAuthority: 'none' }
}
