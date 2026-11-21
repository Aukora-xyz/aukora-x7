/**
 * HER VOICE MEMORY, THE HOME HALF (the voice memory, 2026-11-16;
 * ). The formats of the voice memory design, implemented from its text:
 *
 * - Canonical JSON: UTF-8, object keys sorted by code unit, no whitespace, safe integers only (no float, no -0), no
 *   undefined; strings as JSON writes them. `sha256hex(bytes)` is the lower-case hex of SHA-256.
 * - Chain record (one canonical line of /dsh/home/auma/voice/chain.v1.jsonl): `{ v: 1, seq, prev, at, conv, turn,
 *   kind: "exchange", heardC, saidC, ended, path, calls }`. `digest(record)` = sha256hex(canonical(record)); the next
 *   record's `prev` is that digest (64 zeros for seq 1).
 * - Commitments: heardC = sha256hex(salt || 0x00 || utf8(heard)), saidC = sha256hex(salt || 0x01 || utf8(said)).
 * - Words record (one canonical line of /dsh/home/auma/voice/words.v1.jsonl): `{ seq, salt, heard, said }`. The salt
 *   lives only here, never in the chain record.
 * - Gap record (DESIGN.md recovery rules): `{ v: 1, kind: "gap", seq, prev, at, missingFrom, missingTo }` with
 *   `seq === missingTo`; it starts a new segment: its `prev` is the edge's digest of the record at `missingTo`, and the
 *   next record names that same digest. It has no words.
 *
 * PURE ON PURPOSE: no import. The only globals are `crypto.subtle` and TextEncoder (a browser worker has both). It lives
 * under storage/ so the frozen fence closes it to her proposals: the judge of her own chain is not hers to rewrite.
 * Every write goes through `createVoiceMemoryStore` (the worker route `/__x6__/voice-memory`); the verifier tool only
 * reads.
 * @module storage/voice-memory
 */

export const VOICE_MEMORY_ROOT = '/dsh/home/auma/voice'
export const VOICE_MEMORY_CHAIN = `${VOICE_MEMORY_ROOT}/chain.v1.jsonl`
export const VOICE_MEMORY_WORDS = `${VOICE_MEMORY_ROOT}/words.v1.jsonl`
export const VOICE_MEMORY_ZERO = '0'.repeat(64)
export const VOICE_MEMORY_TOOL = 'x6_voice_memory'
export const VOICE_MEMORY_ACTIONS = Object.freeze(['verify', 'tail', 'search', 'head'] as const)
export const VOICE_MEMORY_LIMITS = Object.freeze({
  heardChars: 4000, saidChars: 6000, convChars: 80, turnChars: 160, calls: 8, callIdChars: 200, modelChars: 80, effortChars: 16,
  appendItems: 8, bodyBytes: 65_536, tailDefault: 5, tailMax: 20, searchHits: 10, searchAround: 200, queryChars: 200,
})
/** The fixed closing sentence of every answer of the verifier (DESIGN.md). */
export const VOICE_MEMORY_SCOPE = 'This compares her home with her own edge: it catches bugs and a changed file, not a rewrite by whoever controls both.'
/** What the comparison with the edge rests on: its status carries only the first 12 hex of its head digest. */
export const VOICE_MEMORY_COMPARED = 'the edge’s head by seq and the first 12 hex of its digest (its status carries no more)'

export type VoiceMemoryCall = { id: string; req: string; res: string; model: string; effort: string; rid: string }
export type VoiceMemoryExchange = {
  v: 1
  seq: number
  prev: string
  at: number
  conv: string
  turn: string
  kind: 'exchange'
  heardC: string
  saidC: string
  ended: 'answered' | 'cut' | 'handed' | 'failed' | 'refused'
  path: 'fast' | 'governed'
  calls: VoiceMemoryCall[]
}
export type VoiceMemoryGap = { v: 1; kind: 'gap'; seq: number; prev: string; at: number; missingFrom: number; missingTo: number }
export type VoiceMemoryRecord = VoiceMemoryExchange | VoiceMemoryGap
export type VoiceMemoryWords = { seq: number; salt: string; heard: string; said: string }

const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const RID = /^[A-Za-z0-9_-]{0,80}$/
const EFFORT = /^[a-z]{0,16}$/
const ENDS = ['answered', 'cut', 'handed', 'failed', 'refused']
const PATHS = ['fast', 'governed']
const EXCHANGE_KEYS = ['v', 'seq', 'prev', 'at', 'conv', 'turn', 'kind', 'heardC', 'saidC', 'ended', 'path', 'calls']
const GAP_KEYS = ['v', 'kind', 'seq', 'prev', 'at', 'missingFrom', 'missingTo']
const CALL_KEYS = ['id', 'req', 'res', 'model', 'effort', 'rid']
const WORDS_KEYS = ['seq', 'salt', 'heard', 'said']

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const bounded = (value: unknown, chars: number): value is string => typeof value === 'string' && value.length <= chars

/**
 * The canonical JSON text of `value`. Throws for anything outside the form (a float, -0, undefined, a function, a
 * class instance, an array hole).
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error('VOICE_MEMORY_CANON: integers only')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error('VOICE_MEMORY_CANON: no holes')
      items.push(canonical(value[index]))
    }
    return `[${items.join(',')}]`
  }
  if (plain(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw new Error('VOICE_MEMORY_CANON: outside the form')
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
/** Lower-case hex of SHA-256 over `bytes`. */
export async function sha256hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
}
const fromHex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], pair => Number.parseInt(pair, 16))

/** digest(record) = sha256hex(canonical(record)). */
export async function recordDigest(record: unknown): Promise<string> {
  return sha256hex(new TextEncoder().encode(canonical(record)))
}

/** sha256hex(salt || tag || utf8(text)); tag 0 for heard, 1 for said. */
export async function commitment(saltHex: string, tag: 0 | 1, text: string): Promise<string> {
  const salt = fromHex(saltHex)
  const words = new TextEncoder().encode(text)
  const bytes = new Uint8Array(salt.byteLength + 1 + words.byteLength)
  bytes.set(salt, 0)
  bytes[salt.byteLength] = tag
  bytes.set(words, salt.byteLength + 1)
  return sha256hex(bytes)
}

function validCall(call: unknown): boolean {
  return exactKeys(call, CALL_KEYS) && bounded(call.id, VOICE_MEMORY_LIMITS.callIdChars) && call.id !== ''
    && typeof call.req === 'string' && HEX64.test(call.req) && typeof call.res === 'string' && (call.res === '' || HEX64.test(call.res))
    && bounded(call.model, VOICE_MEMORY_LIMITS.modelChars) && typeof call.effort === 'string' && EFFORT.test(call.effort)
    && typeof call.rid === 'string' && RID.test(call.rid)
}

/** An exchange record exactly as DESIGN.md writes it (shape and caps). */
export function validRecord(record: unknown): record is VoiceMemoryExchange {
  return exactKeys(record, EXCHANGE_KEYS) && record.v === 1 && positive(record.seq) && typeof record.prev === 'string' && HEX64.test(record.prev)
    && Number.isSafeInteger(record.at) && (record.at as number) >= 0 && bounded(record.conv, VOICE_MEMORY_LIMITS.convChars)
    && bounded(record.turn, VOICE_MEMORY_LIMITS.turnChars) && record.kind === 'exchange'
    && typeof record.heardC === 'string' && HEX64.test(record.heardC) && typeof record.saidC === 'string' && HEX64.test(record.saidC)
    && ENDS.includes(record.ended as string) && PATHS.includes(record.path as string)
    && Array.isArray(record.calls) && record.calls.length <= VOICE_MEMORY_LIMITS.calls && record.calls.every(validCall)
    && (record.seq !== 1 || record.prev === VOICE_MEMORY_ZERO)
}

/** A gap record (DESIGN.md recovery rules). */
export function validGap(record: unknown): record is VoiceMemoryGap {
  return exactKeys(record, GAP_KEYS) && record.v === 1 && record.kind === 'gap' && positive(record.missingFrom) && positive(record.missingTo)
    && record.missingFrom <= record.missingTo && record.seq === record.missingTo
    && typeof record.prev === 'string' && HEX64.test(record.prev) && Number.isSafeInteger(record.at) && (record.at as number) >= 0
}

/** A words record (shape and caps). */
export function validWords(words: unknown): words is VoiceMemoryWords {
  return exactKeys(words, WORDS_KEYS) && positive(words.seq) && typeof words.salt === 'string' && HEX32.test(words.salt)
    && bounded(words.heard, VOICE_MEMORY_LIMITS.heardChars) && bounded(words.said, VOICE_MEMORY_LIMITS.saidChars)
}

/** Both commitments of `record` open with `words` (same seq, same salt). */
export async function opens(record: VoiceMemoryExchange, words: VoiceMemoryWords): Promise<boolean> {
  if (words.seq !== record.seq) return false
  return await commitment(words.salt, 0, words.heard) === record.heardC && await commitment(words.salt, 1, words.said) === record.saidC
}

/** The digest the next record names: a gap passes on its `prev`; an exchange its own digest. */
export async function linkDigest(record: VoiceMemoryRecord): Promise<string> {
  return record.kind === 'gap' ? record.prev : recordDigest(record)
}

// ---- her home's files ----

/** The VFS calls the store and the verifier make (her MemoryVfs). */
export interface VoiceMemoryVfs {
  existsSync(path: string): boolean
  statSync(path: string): { isDirectory(): boolean; isFile(): boolean }
  lstatSync?(path: string): { isSymbolicLink(): boolean }
  readFileSync(path: string, options?: unknown): string | Uint8Array
  writeFileSync(path: string, data: string): void
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown
  unlinkSync?(path: string): void
}

export type VoiceMemoryHead = { ok: true; seq: number; digest: string } | { ok: false; code: string; seq: number; digest: string }

/** Refuse a symbolic link on the way, and a folder where a file is wanted (the confinement voice-scratch.ts uses). */
function confined(vfs: VoiceMemoryVfs): boolean {
  for (const step of [VOICE_MEMORY_ROOT, VOICE_MEMORY_CHAIN, VOICE_MEMORY_WORDS]) {
    if (!vfs.existsSync(step)) continue
    if (vfs.lstatSync?.(step).isSymbolicLink() === true) return false
    const folder = step === VOICE_MEMORY_ROOT
    if (folder !== vfs.statSync(step).isDirectory()) return false
  }
  return true
}

const readText = (vfs: VoiceMemoryVfs, path: string): string | null => {
  if (!vfs.existsSync(path)) return null
  const data = vfs.readFileSync(path, 'utf8')
  return typeof data === 'string' ? data : new TextDecoder().decode(data)
}

/** The lines of a file (null when absent); `broken` when it does not end with a newline (a cut write). */
function linesOf(text: string | null): { lines: string[]; broken: boolean } {
  if (text === null || text === '') return { lines: [], broken: false }
  return { lines: text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n'), broken: !text.endsWith('\n') }
}

/** One chain line as a record, or null when it is not a canonical, valid record. */
function parseRecord(line: string): VoiceMemoryRecord | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!validRecord(value) && !validGap(value)) return null
  try { return canonical(value) === line ? value : null } catch { return null }
}

/** One line of her voice chain file as a record, or null (her timeline reads the exchange a pointer names). */
export const parseVoiceMemoryLine = (line: string): VoiceMemoryRecord | null => parseRecord(line)

/** Her home's head: the last record's seq and the digest the next record must name; seq 0 and 64 zeros when empty. */
export async function voiceMemoryHead(vfs: VoiceMemoryVfs): Promise<VoiceMemoryHead> {
  if (!confined(vfs)) return { ok: false, code: 'HOME_UNREADABLE', seq: 0, digest: VOICE_MEMORY_ZERO }
  const { lines, broken } = linesOf(readText(vfs, VOICE_MEMORY_CHAIN))
  if (lines.length === 0 && !broken) return { ok: true, seq: 0, digest: VOICE_MEMORY_ZERO }
  const last = broken ? null : parseRecord(lines.at(-1) ?? '')
  if (!last) return { ok: false, code: 'HOME_UNREADABLE', seq: 0, digest: VOICE_MEMORY_ZERO }
  return { ok: true, seq: last.seq, digest: await linkDigest(last) }
}

export type VoiceMemoryAppendCode = 'GAP' | 'FORK' | 'ITEM_INVALID' | 'COMMITMENT' | 'TOO_MANY_ITEMS' | 'HOME_UNREADABLE' | 'WRITE_FAILED'
export type VoiceMemoryAppend = { ok: true; seq: number; digest: string }
  | { ok: false; code: VoiceMemoryAppendCode; seq: number; digest: string }

/**
 * Append items `{ record, words }` (a gap's words absent or null) in order. EVERY item is checked before anything is
 * written: seq one above the last (an item already in her home with the same bytes is skipped; another one at that seq
 * is a FORK; a seq further on is a GAP), `prev` the last record's link digest, shapes and caps, both commitments open.
 * Then the words lines and the chain lines are written together; a failed write puts both files back as they were. A
 * refusal answers its code with her home's head, unchanged.
 */
export async function appendVoiceMemory(vfs: VoiceMemoryVfs, items: unknown): Promise<VoiceMemoryAppend> {
  return (await appendWritten(vfs, items)).answer
}

type Written = { answer: VoiceMemoryAppend; written: VoiceMemoryExchange[] }
/** appendVoiceMemory, and the exchange records it wrote (none on a refusal or a resend; never a gap), in order. */
async function appendWritten(vfs: VoiceMemoryVfs, items: unknown): Promise<Written> {
  const head = await voiceMemoryHead(vfs)
  const written: VoiceMemoryExchange[] = []
  const refuse = (code: VoiceMemoryAppendCode): Written =>
    ({ answer: { ok: false, code, seq: head.seq, digest: head.digest }, written: [] })
  if (!head.ok) return refuse('HOME_UNREADABLE')
  if (!Array.isArray(items) || items.length === 0) return refuse('ITEM_INVALID')
  if (items.length > VOICE_MEMORY_LIMITS.appendItems) return refuse('TOO_MANY_ITEMS')
  const chainLines = linesOf(readText(vfs, VOICE_MEMORY_CHAIN)).lines
  let existing: Map<number, string> | null = null
  const lineAt = (seq: number): string | undefined => {
    existing ??= new Map(chainLines.map(line => [parseRecord(line)?.seq ?? -1, line]))
    return existing.get(seq)
  }
  let last = { seq: head.seq, digest: head.digest }
  const newChain: string[] = []
  const newWords: string[] = []
  for (const item of items) {
    if (!plain(item) || !Object.hasOwn(item, 'record')) return refuse('ITEM_INVALID')
    const record = item.record
    const words = item.words ?? null
    const gap = validGap(record)
    if (!gap && !validRecord(record)) return refuse('ITEM_INVALID')
    if (gap ? words !== null : !validWords(words)) return refuse('ITEM_INVALID')
    const line = canonical(record)
    const first = gap ? record.missingFrom : record.seq
    if (first <= last.seq) {
      // Already in her home with these exact bytes (a resend): skipped. Anything else at that seq is a fork.
      if (newChain.length === 0 && lineAt(record.seq) === line) continue
      return refuse('FORK')
    }
    if (first > last.seq + 1) return refuse('GAP')
    if (!gap) {
      if (record.prev !== last.digest) return refuse('FORK')
      if (!await opens(record, words as VoiceMemoryWords)) return refuse('COMMITMENT')
      newWords.push(canonical(words))
      written.push(record)
    }
    newChain.push(line)
    last = { seq: record.seq, digest: await linkDigest(record) }
  }
  if (newChain.length === 0) return { answer: { ok: true, seq: head.seq, digest: head.digest }, written: [] }
  const oldChain = readText(vfs, VOICE_MEMORY_CHAIN)
  const oldWords = readText(vfs, VOICE_MEMORY_WORDS)
  const restore = (path: string, old: string | null): void => {
    try {
      if (old !== null) vfs.writeFileSync(path, old)
      else if (vfs.existsSync(path)) vfs.unlinkSync?.(path)
    } catch { /* best effort; the head read next reports what is there */ }
  }
  try {
    vfs.mkdirSync(VOICE_MEMORY_ROOT, { recursive: true })
    if (!confined(vfs)) return refuse('HOME_UNREADABLE')
    if (newWords.length > 0) vfs.writeFileSync(VOICE_MEMORY_WORDS, `${oldWords ?? ''}${newWords.map(line => `${line}\n`).join('')}`)
    try {
      vfs.writeFileSync(VOICE_MEMORY_CHAIN, `${oldChain ?? ''}${newChain.map(line => `${line}\n`).join('')}`)
    } catch (error) {
      restore(VOICE_MEMORY_WORDS, oldWords)
      throw error
    }
  } catch {
    return refuse('WRITE_FAILED')
  }
  return { answer: { ok: true, seq: last.seq, digest: last.digest }, written }
}

/**
 * One writer: appends run one after another (each checks against the head the one before left). `onAppended`
 * is told, after each append that wrote, the exchange records it wrote, in order (her timeline's voice pointers); what
 * it does never changes the answer, and a throw from it is swallowed.
 */
export function createVoiceMemoryStore(vfs: VoiceMemoryVfs, onAppended?: (records: readonly VoiceMemoryExchange[]) => void) {
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => {})
    return run
  }
  return {
    head: (): Promise<VoiceMemoryHead> => serial(() => voiceMemoryHead(vfs)),
    append: (items: unknown): Promise<VoiceMemoryAppend> => serial(async () => {
      const { answer, written } = await appendWritten(vfs, items)
      if (written.length > 0) { try { onAppended?.(written) } catch { /* the timeline never fails a voice append */ } }
      return answer
    }),
  }
}

// ---- the verifier: x6_voice_memory ----

export type VoiceMemoryEdgeHead = { seq: number; digest12: string; fork: boolean }
export interface VoiceMemoryToolDeps {
  vfs: VoiceMemoryVfs
  /** The edge's managed_status answer (the read x6_voice_status makes); throws when it cannot be read. */
  edgeStatus: () => Promise<unknown>
  nowMs: () => number
}

/** How long ago, in plain words. */
export function memoryAge(at: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} h ago`
  return `${String(Math.floor(seconds / 86_400))} d ago`
}

/**
 * The edge's head from its status, or null when the status does not carry one in the contract's shape. Only a status
 * with the switch on can carry a head the edge read: with it off the edge's status route never reaches the bridge and
 * answers its default block (seq 0, 12 zeros), which says nothing about her memory (review home 1).
 */
export function edgeHeadOf(status: unknown): VoiceMemoryEdgeHead | null {
  if (!plain(status) || status.switch !== 'on') return null
  const memory = status.memory
  if (!plain(memory) || !Number.isSafeInteger(memory.seq) || (memory.seq as number) < 0) return null
  if (typeof memory.digest12 !== 'string' || !/^[0-9a-f]{12}$/.test(memory.digest12)) return null
  return { seq: memory.seq as number, digest12: memory.digest12, fork: memory.fork === true }
}

type Walk = {
  records: VoiceMemoryRecord[]
  links: Map<number, string>
  words: Map<number, VoiceMemoryWords>
  broken: { seq: number; check: string } | null
  wordsMissing: number[]
  /** The spans her home records as gaps (review home 2): their exchanges are not in her home. */
  gaps: Array<{ from: number; to: number }>
}

/** What a gap means, in every answer that names one: no digest covers a gap record's own fields. */
const GAPS_WHY = 'these spans are gap records: their exchanges are not in her home, and no digest covers a gap record\'s own fields '
  + '(the record after it names only the edge\'s digest), so this check cannot show what was there'
const gapsOf = (home: Walk): Record<string, unknown> => ({ gaps: home.gaps.slice(0, 50), gapCount: home.gaps.length,
  ...(home.gaps.length > 0 ? { gapsWhy: GAPS_WHY } : {}) })

/** Walk the chain file: every line canonical and valid, every seq in order, every link, every commitment that has words. */
async function walk(vfs: VoiceMemoryVfs): Promise<Walk> {
  const out: Walk = { records: [], links: new Map(), words: new Map(), broken: null, wordsMissing: [], gaps: [] }
  if (!confined(vfs)) { out.broken = { seq: 0, check: 'a link or a folder stands where her memory files belong' }; return out }
  for (const line of linesOf(readText(vfs, VOICE_MEMORY_WORDS)).lines) {
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    if (validWords(value) && !out.words.has(value.seq)) out.words.set(value.seq, value)
  }
  const chain = linesOf(readText(vfs, VOICE_MEMORY_CHAIN))
  let last = { seq: 0, digest: VOICE_MEMORY_ZERO }
  for (const line of chain.lines) {
    const expected = last.seq + 1
    const record = parseRecord(line)
    if (!record) { out.broken = { seq: expected, check: 'the line is not a canonical record' }; return out }
    const first = record.kind === 'gap' ? record.missingFrom : record.seq
    if (first !== expected) { out.broken = { seq: expected, check: `the record says seq ${String(first)}` }; return out }
    if (record.kind === 'exchange') {
      if (record.prev !== last.digest) { out.broken = { seq: record.seq, check: 'it does not name the digest of the record before it' }; return out }
      const words = out.words.get(record.seq)
      if (!words) out.wordsMissing.push(record.seq)
      else if (!await opens(record, words)) { out.broken = { seq: record.seq, check: 'its words do not open its commitments' }; return out }
    } else {
      out.gaps.push({ from: record.missingFrom, to: record.missingTo })
    }
    out.records.push(record)
    last = { seq: record.seq, digest: await linkDigest(record) }
    out.links.set(record.seq, last.digest)
  }
  if (chain.broken) out.broken = { seq: last.seq + 1, check: 'the file ends inside a line' }
  return out
}

const finish = (answer: Record<string, unknown>): Record<string, unknown> => ({ ...answer, note: VOICE_MEMORY_SCOPE })

async function verify(deps: VoiceMemoryToolDeps): Promise<Record<string, unknown>> {
  const home = await walk(deps.vfs)
  const seq = home.records.at(-1)?.seq ?? 0
  const digest = home.links.get(seq) ?? VOICE_MEMORY_ZERO
  const homeHead = { seq, digest }
  // Review home 2: every verify answer names the gap spans her home records (an empty list when none).
  const gaps = gapsOf(home)
  if (home.broken) return finish({ ok: true, action: 'verify', verdict: 'BROKEN_AT', seq: home.broken.seq, why: home.broken.check, home: homeHead, ...gaps })
  if (home.wordsMissing.length > 0) {
    return finish({ ok: true, action: 'verify', verdict: 'WORDS_MISSING', seqs: home.wordsMissing.slice(0, 50), count: home.wordsMissing.length,
      why: 'these records have no words in her home and no deletion record', home: homeHead, ...gaps })
  }
  let edge: VoiceMemoryEdgeHead | null = null
  try { edge = edgeHeadOf(await deps.edgeStatus()) } catch { edge = null }
  if (!edge) {
    return finish({ ok: true, action: 'verify', verdict: 'EDGE_UNREACHABLE', home: homeHead, records: home.records.length,
      why: 'her edge did not answer with its memory head: this is not known, and it is not a pass', ...gaps })
  }
  const base = { ok: true, action: 'verify', home: homeHead, edge: { seq: edge.seq, digest12: edge.digest12, fork: edge.fork }, compared: VOICE_MEMORY_COMPARED, ...gaps }
  // Review home 4: the edge marks a fork and has stopped appending to her home until a person decides; never INTACT.
  if (edge.fork) return finish({ ...base, verdict: 'FORK_AT', seq: edge.seq, why: 'her edge marks a fork at this seq and has stopped appending to her home until a person decides' })
  const at = edge.seq === 0 ? VOICE_MEMORY_ZERO : home.links.get(edge.seq)
  if (edge.seq > seq) return finish({ ...base, verdict: 'INTACT_HOME_BEHIND', behind: edge.seq - seq })
  if (at === undefined || at.slice(0, 12) !== edge.digest12) return finish({ ...base, verdict: 'FORK_AT', seq: edge.seq })
  if (seq > edge.seq) return finish({ ...base, verdict: 'INTACT_EDGE_BEHIND', ahead: seq - edge.seq })
  return finish({ ...base, verdict: 'INTACT_MATCHES_EDGE' })
}

/** One call of the verifier. Every answer ends with VOICE_MEMORY_SCOPE (its `note`, the last field). */
export async function runVoiceMemoryTool(deps: VoiceMemoryToolDeps, args: unknown): Promise<Record<string, unknown>> {
  const input = plain(args) ? args : {}
  const action = input.action
  if (typeof action !== 'string' || !(VOICE_MEMORY_ACTIONS as readonly string[]).includes(action)) {
    return finish({ ok: false, code: 'VOICE_MEMORY_ACTION_INVALID', why: 'action is verify, tail, search or head' })
  }
  if (action === 'verify') return verify(deps)
  if (action === 'head') {
    const head = await voiceMemoryHead(deps.vfs)
    return finish({ ...head, action })
  }
  const home = await walk(deps.vfs)
  const now = deps.nowMs()
  const exchanges = home.records.filter((record): record is VoiceMemoryExchange => record.kind === 'exchange')
  const broken = { ...(home.broken ? { brokenAt: home.broken.seq } : {}), ...(home.gaps.length > 0 ? gapsOf(home) : {}) }
  if (action === 'tail') {
    const asked = input.n === undefined ? VOICE_MEMORY_LIMITS.tailDefault : input.n
    if (!Number.isSafeInteger(asked) || (asked as number) < 1 || (asked as number) > VOICE_MEMORY_LIMITS.tailMax) {
      return finish({ ok: false, code: 'VOICE_MEMORY_N_INVALID', why: `n is 1 to ${String(VOICE_MEMORY_LIMITS.tailMax)}` })
    }
    const rows = exchanges.slice(-(asked as number)).map((record) => {
      const words = home.words.get(record.seq)
      return { seq: record.seq, age: memoryAge(record.at, now), ended: record.ended, path: record.path,
        heard: words?.heard ?? null, said: words?.said ?? null }
    })
    return finish({ ok: true, action, kept: exchanges.length, exchanges: rows, ...broken })
  }
  const query = input.q
  if (typeof query !== 'string' || query.trim() === '' || query.length > VOICE_MEMORY_LIMITS.queryChars) {
    return finish({ ok: false, code: 'VOICE_MEMORY_QUERY_INVALID', why: `q is text, at most ${String(VOICE_MEMORY_LIMITS.queryChars)} characters` })
  }
  const needle = query.toLowerCase()
  const hits: Array<Record<string, unknown>> = []
  for (const record of [...exchanges].reverse()) {
    if (hits.length >= VOICE_MEMORY_LIMITS.searchHits) break
    const words = home.words.get(record.seq)
    if (!words) continue
    for (const [who, text] of [['heard', words.heard], ['said', words.said]] as const) {
      const index = text.toLowerCase().indexOf(needle)
      if (index < 0) continue
      const half = Math.floor((VOICE_MEMORY_LIMITS.searchAround - needle.length) / 2)
      const start = Math.max(0, index - Math.max(0, half))
      const around = text.slice(start, start + VOICE_MEMORY_LIMITS.searchAround)
      hits.push({ seq: record.seq, age: memoryAge(record.at, now), in: who, text: around })
      break
    }
  }
  return finish({ ok: true, action, hits, ...broken })
}

/** Her tool, in the loader's flat parameter dialect (registerBuiltin). */
export function voiceMemoryToolSpec(deps: () => VoiceMemoryToolDeps, enforce: (args: Record<string, unknown>) => void) {
  return {
    name: VOICE_MEMORY_TOOL,
    description: 'Your voice memory: the chain of your spoken exchanges kept in your home (/dsh/home/auma/voice/). A read; it changes '
      + 'nothing. `verify` walks the chain (every digest, link and commitment) and compares its head with your edge’s; verdicts '
      + 'INTACT_MATCHES_EDGE, INTACT_HOME_BEHIND, INTACT_EDGE_BEHIND, FORK_AT, BROKEN_AT, WORDS_MISSING, EDGE_UNREACHABLE (unknown, '
      + 'never a pass). `tail` { n <= 20 } the last exchanges word for word with their age; `search` { q } plain text over the words, '
      + `at most 10 hits; \`head\` the last seq and digest. ${VOICE_MEMORY_SCOPE}`,
    parameters: {
      action: { type: 'string', required: true, enum: [...VOICE_MEMORY_ACTIONS], description: 'verify, tail, search or head.' },
      n: { type: 'number', description: 'For tail: how many exchanges, 1 to 20 (default 5).' },
      q: { type: 'string', description: 'For search: the text to find (plain, any case).' },
    },
    async execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      enforce(args)
      return runVoiceMemoryTool(deps(), args)
    },
  }
}

// ---- ONE MEMORY (the one memory, 2026-11-16;
// ): every conversation of hers is told, once, what was said in Auma Live since it last heard. The
// feed itself now reads her timeline (storage/memory-timeline.ts createHeardFeed) and uses the helpers below ----

/** One exchange with its words, as a conversation is told it. */
export type VoiceHeardExchange = Pick<VoiceMemoryExchange, 'seq' | 'at' | 'ended' | 'path'> & { heard: string; said: string }
/** `ok: false` is "none": a file missing a line's end, unreadable or not parsing (never a throw). */
export type VoiceMemorySince = { ok: boolean; head: number; exchanges: VoiceHeardExchange[] }

/** How far back the reader walks the chain for exchanges with words, per exchange asked for (a bound, not a rule). */
const SINCE_SCAN_PER_EXCHANGE = 4
/** The most the reader decodes of each file, from its end (review: a turn never pays for her whole store). */
const SINCE_TAIL_BYTES = 262_144

/**
 * The last `cap` bytes of a file as complete lines (null when absent). The stored bytes are taken as they are (her
 * MemoryVfs hands its bytes over without a copy) and only the tail is decoded; when the file is longer, the first,
 * cut line of the tail is dropped (a line break byte never sits inside a UTF-8 sequence).
 */
export const readFileTail = (vfs: VoiceMemoryVfs, path: string, cap: number): { text: string | null; long: boolean } => {
  if (!vfs.existsSync(path)) return { text: null, long: false }
  const data = vfs.readFileSync(path)
  const long = typeof data === 'string' ? data.length > cap : data.byteLength > cap
  const text = typeof data === 'string'
    ? (long ? data.slice(-cap) : data)
    : new TextDecoder().decode(long ? data.subarray(data.byteLength - cap) : data)
  if (!long) return { text, long }
  const firstBreak = text.indexOf('\n')
  return { text: firstBreak < 0 ? '' : text.slice(firstBreak + 1), long }
}

/**
 * The exchange records of her home's chain with `seq > afterSeq` whose words are in her home and open their
 * commitments, newest last, at most `limits.exchanges` (the newest), plus the head (the last record's seq, a gap
 * included). Reads only the two files, and of each at most its last 256 KiB (an exchange whose words lie further back is
 * skipped). Gap records are skipped. Never throws: a chain file that is cut, unreadable or does not parse where it is
 * read answers none (`ok: false`); a missing words line skips its exchange.
 */
export async function voiceMemorySince(vfs: VoiceMemoryVfs, afterSeq: number, limits: { exchanges: number }): Promise<VoiceMemorySince> {
  const none: VoiceMemorySince = { ok: false, head: 0, exchanges: [] }
  try {
    const max = Number.isSafeInteger(limits.exchanges) ? Math.max(0, Math.min(limits.exchanges, VOICE_MEMORY_LIMITS.tailMax)) : 0
    const after = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0
    if (!confined(vfs)) return none
    const chainTail = readFileTail(vfs, VOICE_MEMORY_CHAIN, SINCE_TAIL_BYTES)
    const chain = linesOf(chainTail.text)
    if (chain.broken) return none
    // A file longer than the tail with no whole line at its end has no head this reader can see.
    if (chain.lines.length === 0) return chainTail.long ? none : { ok: true, head: 0, exchanges: [] }
    const candidates: VoiceMemoryExchange[] = []
    let head = 0
    for (let index = chain.lines.length - 1; index >= 0; index -= 1) {
      const record = parseRecord(chain.lines[index] ?? '')
      if (!record) return none
      if (index === chain.lines.length - 1) head = record.seq
      if (record.seq <= after || candidates.length >= max * SINCE_SCAN_PER_EXCHANGE) break
      if (record.kind === 'exchange') candidates.push(record)
    }
    if (candidates.length === 0) return { ok: true, head, exchanges: [] }
    const wanted = new Set(candidates.map(record => record.seq))
    const lowest = Math.min(...wanted)
    const found = new Map<number, VoiceMemoryWords>()
    const wordLines = linesOf(readFileTail(vfs, VOICE_MEMORY_WORDS, SINCE_TAIL_BYTES).text).lines
    for (let index = wordLines.length - 1; index >= 0; index -= 1) {
      let value: unknown
      try { value = JSON.parse(wordLines[index] ?? '') } catch { continue }
      if (!validWords(value)) continue
      if (value.seq < lowest) break
      // Walked from the end: the earliest line of a seq is kept, as the verifier keeps it.
      if (wanted.has(value.seq)) found.set(value.seq, value)
    }
    const exchanges: VoiceHeardExchange[] = []
    for (const record of candidates) {
      if (exchanges.length >= max) break
      const words = found.get(record.seq)
      if (!words || !await opens(record, words)) continue
      exchanges.push({ seq: record.seq, at: record.at, ended: record.ended, path: record.path, heard: words.heard, said: words.said })
    }
    return { ok: true, head, exchanges: exchanges.reverse() }
  } catch {
    return none
  }
}

/** The kind of the one message a conversation is given (recognisable in her logs; memory-timeline.ts HEARD_SOURCE). */
export const VOICE_HEARD_SOURCE = 'auma:voice-heard'
export const VOICE_HEARD_LIMITS = Object.freeze({
  exchanges: 6, heardChars: 400, saidChars: 600, bytes: 4096, conversations: 512, tailBytes: SINCE_TAIL_BYTES,
})
/** How long ago, in plain words ("just now", "3 minutes ago", "2 hours ago", "4 days ago"). */
export function heardAge(at: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - at) / 1000))
  const say = (count: number, unit: string): string => `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return say(Math.floor(seconds / 60), 'minute')
  if (seconds < 86_400) return say(Math.floor(seconds / 3600), 'hour')
  return say(Math.floor(seconds / 86_400), 'day')
}

/**
 * Spoken text as one quoted value: the page's rule for its spoken-since block (genesis-live.js spokenSincePart: JSON
 * string quoting), so a quote, a backslash or a line break stays inside the value; the line and paragraph separators
 * JSON leaves bare are escaped too, so nothing spoken can start a line of its own.
 */
export const quoteSpoken = (text: string): string => JSON.stringify(text).replace(/[\u2028\u2029\u0085]/g, mark => `\\u${mark.charCodeAt(0).toString(16).padStart(4, '0')}`)
