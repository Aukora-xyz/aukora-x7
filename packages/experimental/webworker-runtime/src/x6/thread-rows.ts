/**
 * The one reading of a stored thread row that her read tools let out: `x6_threads` (list, tail, search) and
 * `x6_browser_estate` search both import it, so the same rows leave both ways and no other row does.
 *
 * Only his and her words leave: his prompts (`user/message` from the user, voice framing removed), her replies
 * (`assistant/message` text, no reasoning; tool calls by name only) and thread titles (`session/title`). Tool results,
 * tool-call arguments, system prompts and injected notices are never decoded into text. Every text passes
 * {@link withholdSecrets} whole, before any cut.
 * @module x6/thread-rows
 */
import { withholdSecrets } from './secret-shapes.ts'

/** A thread title leaves at most this many characters. */
export const TITLE_CHARS = 120
/** Framing text parts the page adds to a spoken turn; they are not his words. */
const FRAMING_PREFIXES = Object.freeze(['[spoken to Auma Live;', '[Auma Live spoken channel', '[your other threads'])
/** The row types whose words may leave a read tool. */
export const WORD_ROWS: ReadonlySet<string> = Object.freeze(new Set(['user/message', 'assistant/message', 'session/title']))

const decoder = new TextDecoder()
const TYPE_PREFIX = /^\{"type":"([^"\\]{1,64})"/

export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (line: Uint8Array | string, length?: number): string =>
  typeof line === 'string' ? (length === undefined ? line : line.slice(0, length)) : decoder.decode(length === undefined ? line : line.subarray(0, length))

/** The event type when the row states it first (as Session writes it), else null (the row is then parsed to know). */
export function rowType(line: Uint8Array | string): string | null {
  return TYPE_PREFIX.exec(text(line, 96))?.[1] ?? null
}

export interface Row { type: string; time: number | null; data: Record<string, unknown> }

/** Parse one row when its type is wanted; null for any other row or anything that is not a row. */
export function parseRow(line: Uint8Array | string, wanted: ReadonlySet<string>): Row | null {
  const declared = rowType(line)
  if (declared !== null && !wanted.has(declared)) return null
  let parsed: unknown
  try { parsed = JSON.parse(text(line)) } catch { return null }
  if (!record(parsed) || typeof parsed.type !== 'string' || !wanted.has(parsed.type) || !record(parsed.data)) return null
  return { type: parsed.type, time: Number.isSafeInteger(parsed.time) ? parsed.time as number : null, data: parsed.data }
}

/** A phrase as it appears inside a raw row (JSON-escaped, lower case): a cheap test before a row is parsed. */
export const rawNeedle = (needle: string): string => JSON.stringify(needle).slice(1, -1).toLowerCase()

export const squash =(value: string): string => value.replace(/\s+/g, ' ').trim()
export const cut = (value: string, chars: number): string => (value.length <= chars ? value : `${value.slice(0, Math.max(0, chars - 1))}…`)
const FIELD_TAG = /\[field [^\]]{0,240}\]/g

export interface Words { who: 'he' | 'she'; text: string; spoken: boolean; tools: string[]; turn: number | null }

/** His or her words in one row, secrets withheld; null for every other row. */
export function wordsOf(row: Row): Words | null {
  // An assistant row before format v1 kept its content beside `turn` instead of in `message`.
  const message = row.type === 'user/message' ? row.data
    : row.type === 'assistant/message' ? (record(row.data.message) ? row.data.message : row.data) : null
  if (!record(message) || !Array.isArray(message.content)) return null
  if (row.type === 'user/message') {
    if (!record(message.source) || message.source.kind !== 'user') return null
    let spoken = false
    const parts: string[] = []
    for (const block of message.content) {
      if (!record(block)) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        if (FRAMING_PREFIXES.some(prefix => (block.text as string).startsWith(prefix))) { spoken = true; continue }
        parts.push(block.text)
      } else if (block.type === 'image') parts.push('[image]')
      else if (block.type === 'file') parts.push('[file]')
    }
    return { who: 'he', text: squash(withholdSecrets(parts.join(' '))), spoken, tools: [], turn: null }
  }
  const parts: string[] = []
  const tools: string[] = []
  for (const block of message.content) {
    if (!record(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text.replace(FIELD_TAG, ' '))
    else if (block.type === 'tool-call' && typeof block.name === 'string') tools.push(block.name.slice(0, 64))
  }
  const turn = Number.isSafeInteger(row.data.turn) ? row.data.turn as number : null
  return { who: 'she', text: squash(withholdSecrets(parts.join(' '))), spoken: false, tools, turn }
}

/** A `session/title` row's title, secrets withheld and cut to {@link TITLE_CHARS}; null for every other row. */
export const titleOf = (row: Row): string | null =>
  row.type === 'session/title' && typeof row.data.title === 'string' ? cut(squash(withholdSecrets(row.data.title)), TITLE_CHARS) : null
