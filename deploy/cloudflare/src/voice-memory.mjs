/**
 * HER VOICE'S MEMORY RECORD AND ITS CHAIN. Pure functions, no storage, no network; the formats
 * of the voice memory design exactly (the page lane implements the same text; VECTORS.json pins the bytes).
 *
 * One chain record per finished spoken exchange. A record holds no words: it holds commitments to them (a salted SHA-256
 * per side), the turn's closed facts, and a receipt of each model call; it names the digest of the record before it. The
 * words travel beside it in a words record (with the salt), which can be deleted without touching the chain.
 *
 * Canonical JSON: UTF-8; object keys sorted by UTF-16 code unit; no whitespace; integers only
 * (safe integers; no float, no -0, no NaN or infinity); no undefined. A string is written as the platform JSON writer
 * writes it (its escapes: \" \\ \b \f \n \r \t, \u00XX for the other control characters, \uDXXX for a lone surrogate;
 * every other character as itself, U+2028 and U+2029 included). capsule-canon.mjs is NOT reused: its form is printable
 * ASCII only, strings of at most 2,048 characters and a key grammar, so it refuses the words-free records' own Unicode
 * answer blocks and long fields; this is a second form on purpose, for this record only, pinned by its own vectors.
 */

export const MEMORY_VERSION = 1
export const ZERO_DIGEST = '0'.repeat(64)
/** The caps of DESIGN.md: words, ids, calls; the edge's tail and history; one `memory` frame. */
export const MEMORY_LIMITS = Object.freeze({
  heardChars: 4000, saidChars: 6000, convChars: 80, turnChars: 160, calls: 8, callIdChars: 200, modelChars: 80, ridChars: 80,
  tail: 40, history: 12, frameItems: 8, frameBytes: 48000, saltBytes: 16,
})
/** The edge's storage (the VoiceBridge object, DESIGN.md): `{ owner, seq, digest, at }`; the last MEMORY_LIMITS.tail
 * `{ record, words }` pairs; the highest seq her home acknowledged. */
export const MEMORY_KEYS = Object.freeze({ head: 'voice-memory:head', tail: 'voice-memory:tail', synced: 'voice-memory:synced' })
export const MEMORY_ENDS =Object.freeze(['answered', 'cut', 'handed', 'failed', 'refused'])
export const MEMORY_PATHS = Object.freeze(['fast', 'governed'])
/** The effort a call ran at ('' on a wire without one): the fast voice's five levels (voice-fast.mjs FAST_VOICE_EFFORTS). */
export const MEMORY_EFFORTS = Object.freeze(['', 'low', 'medium', 'high', 'xhigh', 'max'])
/** The tags of the two commitments. */
export const COMMIT_TAGS = Object.freeze({ heard: 0, said: 1 })

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_32 = /^[0-9a-f]{32}$/
const RID_RE = /^[A-Za-z0-9_-]{0,80}$/
const RECORD_KEYS = Object.freeze(['v', 'seq', 'prev', 'at', 'conv', 'turn', 'kind', 'heardC', 'saidC', 'ended', 'path', 'calls'])
const CALL_KEYS = Object.freeze(['id', 'req', 'res', 'model', 'effort', 'rid'])
const WORDS_KEYS = Object.freeze(['seq', 'salt', 'heard', 'said'])
const GAP_KEYS = Object.freeze(['v', 'kind', 'seq', 'prev', 'at', 'missingFrom', 'missingTo'])
const encoder = new TextEncoder()

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const positive = value => Number.isSafeInteger(value) && value >= 1
const bounded = (value, chars) => typeof value === 'string' && value.length <= chars
const refused = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code })

/** The canonical JSON text of `value` (see the head of this file). Throws VOICE_MEMORY_CANON for anything outside it. */
export function canonical(value) {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw refused('VOICE_MEMORY_CANON', 'not a safe integer')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const items = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw refused('VOICE_MEMORY_CANON', 'an array with a hole')
      items.push(canonical(value[index]))
    }
    return `[${items.join(',')}]`
  }
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    // Sorted by UTF-16 code unit (the default string order).
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw refused('VOICE_MEMORY_CANON', `not a value of the form (${typeof value})`)
}

const toHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const fromHex = hex => new Uint8Array(hex.match(/../g).map(pair => Number.parseInt(pair, 16)))

/** Lower-case hex of SHA-256 over `bytes`. */
export async function sha256hex(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** A commitment: sha256hex(salt || tag || utf8(text)), tag 0 for his words, 1 for hers. */
export async function commit(saltBytes, tag, text) {
  const words = encoder.encode(String(text))
  const message = new Uint8Array(saltBytes.length + 1 + words.length)
  message.set(saltBytes, 0)
  message[saltBytes.length] = tag
  message.set(words, saltBytes.length + 1)
  return await sha256hex(message)
}

/** digest(record) = sha256hex(utf8(canonical(record))); the next record's `prev`. */
export async function recordDigest(record) {
  return await sha256hex(encoder.encode(canonical(record)))
}

/** `text` cut to at most `chars` UTF-16 code units, never inside a surrogate pair. */
export function cutWords(text, chars) {
  const value = String(text ?? '')
  if (value.length <= chars) return value
  let end = chars
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return value.slice(0, end)
}

/** One call receipt, closed (DESIGN.md: id, req, res, model, effort, rid). */
export function validCall(call) {
  return exactKeys(call, CALL_KEYS) && typeof call.id === 'string' && call.id.length >= 1 && call.id.length <= MEMORY_LIMITS.callIdChars
    && typeof call.req === 'string' && HEX_64.test(call.req) && typeof call.res === 'string' && (call.res === '' || HEX_64.test(call.res))
    && bounded(call.model, MEMORY_LIMITS.modelChars) && MEMORY_EFFORTS.includes(call.effort) && typeof call.rid === 'string' && RID_RE.test(call.rid)
}

/** One exchange chain record, closed shape and caps. */
export function validRecord(record) {
  return exactKeys(record, RECORD_KEYS) && record.v === MEMORY_VERSION && positive(record.seq) && typeof record.prev === 'string' && HEX_64.test(record.prev)
    && (record.seq !== 1 || record.prev === ZERO_DIGEST) && Number.isSafeInteger(record.at) && record.at >= 0
    && bounded(record.conv, MEMORY_LIMITS.convChars) && bounded(record.turn, MEMORY_LIMITS.turnChars) && record.kind === 'exchange'
    && typeof record.heardC === 'string' && HEX_64.test(record.heardC) && typeof record.saidC === 'string' && HEX_64.test(record.saidC)
    && MEMORY_ENDS.includes(record.ended) && MEMORY_PATHS.includes(record.path)
    && Array.isArray(record.calls) && record.calls.length <= MEMORY_LIMITS.calls && record.calls.every(validCall)
}

/** One words record, closed shape and caps. */
export function validWords(words) {
  return exactKeys(words, WORDS_KEYS) && positive(words.seq) && typeof words.salt === 'string' && HEX_32.test(words.salt)
    && bounded(words.heard, MEMORY_LIMITS.heardChars) && bounded(words.said, MEMORY_LIMITS.saidChars)
}

/** Both commitments of `record` open with `words` (same seq, same salt, same words). */
export async function opens(record, words) {
  if (!validRecord(record) || !validWords(words) || words.seq !== record.seq) return false
  const salt = fromHex(words.salt)
  return await commit(salt, COMMIT_TAGS.heard, words.heard) === record.heardC && await commit(salt, COMMIT_TAGS.said, words.said) === record.saidC
}

/**
 * One finished exchange as its chain record and its words record. `salt`: 16 bytes (tests and vectors only); otherwise
 * 16 fresh bytes from crypto.getRandomValues. His and her words are cut to their caps first (never inside a surrogate
 * pair). Throws VOICE_MEMORY_RECORD_INVALID when the result is not a valid record.
 */
export async function makeExchange({ prev, seq, at, conv, turn, heard, said, ended, path, calls = [], salt }) {
  const saltBytes = salt instanceof Uint8Array && salt.length === MEMORY_LIMITS.saltBytes ? salt : crypto.getRandomValues(new Uint8Array(MEMORY_LIMITS.saltBytes))
  const words = { seq, salt: toHex(saltBytes), heard: cutWords(heard, MEMORY_LIMITS.heardChars), said: cutWords(said, MEMORY_LIMITS.saidChars) }
  const record = { v: MEMORY_VERSION, seq, prev, at, conv, turn, kind: 'exchange',
    heardC: await commit(saltBytes, COMMIT_TAGS.heard, words.heard), saidC: await commit(saltBytes, COMMIT_TAGS.said, words.said),
    ended, path, calls: calls.map(call => ({ ...call })) }
  if (!validRecord(record) || !validWords(words)) throw refused('VOICE_MEMORY_RECORD_INVALID', 'the exchange is outside the record format')
  return { record, words }
}

/**
 * A GAP (DESIGN.md "Recovery rules"): her home is behind the edge further than the edge's tail reaches, so the records
 * `missingFrom`..`missingTo` cannot be resent. Her home starts a new segment with this record: it stands for the missing
 * span (`seq` is the span's last seq), and its `prev` is the edge's `prev` of the first resent record (the digest of the
 * record at `missingTo`), so the next record links to it. It carries no words and is never in the edge's own chain.
 */
export function makeGap({ missingFrom, missingTo, prev, at }) {
  return { v: MEMORY_VERSION, kind: 'gap', seq: missingTo, prev, at, missingFrom, missingTo }
}

export function validGap(record) {
  return exactKeys(record, GAP_KEYS) && record.v === MEMORY_VERSION && record.kind === 'gap' && positive(record.missingFrom) && positive(record.missingTo)
    && record.missingFrom <= record.missingTo && record.seq === record.missingTo && typeof record.prev === 'string' && HEX_64.test(record.prev)
    && Number.isSafeInteger(record.at) && record.at >= 0
}

/**
 * The digest of one model call's answer. On the anthropic wire: sha256hex(canonical({ blocks, stop }))
 * over the answer's replay blocks (exactly as kept for the next round) and its stop reason; on the chat wire:
 * sha256hex(canonical({ text, calls })) over her text of that call and its tool calls (`{ name, args }` each). '' when
 * there is no whole answer, or when it holds a value outside the canonical form (a float in a tool input).
 */
export async function answerDigest(answer) {
  if (!isObject(answer)) return ''
  try {
    const value = Array.isArray(answer.blocks) ? { blocks: answer.blocks, stop: typeof answer.stop === 'string' ? answer.stop : null }
      : { text: String(answer.text ?? ''), calls: (Array.isArray(answer.calls) ? answer.calls : []).map(call => ({ name: String(call?.name ?? ''), args: String(call?.args ?? '') })) }
    return await sha256hex(encoder.encode(canonical(value)))
  } catch { return '' }
}
