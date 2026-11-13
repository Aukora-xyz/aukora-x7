/**
 * `x6_threads`: a bounded, tail-first, read-only reader of every thread kept in this browser (A4, R8).
 *
 * Three actions, each named explicitly: `list` (every thread, newest first, with the last line he and she said), `tail`
 * (one thread's last turns) and `search` (a literal phrase in the newest part of each thread). Threads are found the way
 * the app's own session list finds them: `/dsh/home/sessions/<project>/<session>/session[.vN].jsonl`, highest generation.
 *
 * Read-only by construction: the tool sees the store only through {@link ThreadStoreView} (stat, list, ranged read; no
 * write method exists), never writes into a buffer a read returned (any join is a fresh copy), and starts no fetch.
 * Only his and her words leave: his prompts (`user/message` from the user, voice framing removed) and her replies
 * (`assistant/message` text, no reasoning). A tool call leaves as its name only; tool results are never decoded. The
 * reading of a row is the one in ./thread-rows.ts that `x6_browser_estate` search uses too.
 * Secret-shaped runs (PEM blocks, `nsec1…`, `sk-…`, 40 or more base64 or hex characters) leave as `[withheld]`, by the
 * one filter in ./secret-shapes.ts that `x6_browser_estate` search uses too.
 * Nothing under /dsh/home/auma/private is opened, and a thread whose working folder is there is listed without content.
 *
 * Honest gap: this tool carries text from other threads into whichever thread calls it (the voice thread included), and
 * the secret-shape filter above is the only content guard on that text.
 * @module x6/thread-reader
 */
import type { MemoryVfs } from '../storage/memory.ts'
import { decodeSessionWorkspace, PRIVATE_ROOT, privateProject, SESSIONS_ROOT } from './browser-estate.ts'
import { withholdSecrets } from './secret-shapes.ts'
import { cut, parseRow, rawNeedle, record, type Row, rowType, TITLE_CHARS, titleOf, type Words, wordsOf } from './thread-rows.ts'

export const THREAD_ACTIONS = Object.freeze(['list', 'tail', 'search'] as const)
export type ThreadAction = typeof THREAD_ACTIONS[number]

export const THREAD_LIMITS = Object.freeze({
  /** Threads discovered at most (session directories walked). */
  discoverThreads: 2048,
  listThreads: 50,
  listTailBytes: 64 * 1024,
  /**
   * `list`: a title not in the tail window is looked for in the head of the file, by byte scan, this far. Sized so every
   * listed thread gets its header and whole tail: 50 x (4 KiB + 64 KiB + 256 KiB) = 16,200 KiB <= 16,384 KiB.
   */
  listTitleProbeBytes: 256 * 1024,
  listTotalBytes: 16 * 1024 * 1024,
  listLineChars: 160,
  listAnswerBytes: 6 * 1024,
  tailDefaultTurns: 6,
  tailMaxTurns: 12,
  tailFirstBytes: 256 * 1024,
  tailMaxBytes: 4 * 1024 * 1024,
  /** `tail`: the same head byte scan for a title, for one thread. */
  tailTitleProbeBytes: 512 * 1024,
  /** His words get at most 300 characters of a turn, hers the rest of 600. */
  tailHeChars: 300,
  tailTurnChars: 600,
  tailAnswerBytes: 8 * 1024,
  searchQueryChars: 128,
  searchFirstBytes: 256 * 1024,
  searchFileBytes: 4 * 1024 * 1024,
  searchTotalBytes: 32 * 1024 * 1024,
  searchHits: 12,
  searchSnippetChars: 200,
  searchAnswerBytes: 6 * 1024,
  headerBytes: 4096,
  titleChars: TITLE_CHARS,
})

export const VOICE_THREAD_TITLE = '[voice] Auma Live'
const SOURCES = Object.freeze(['browser session store /dsh/home/sessions (this browser only)'])
const GAPS = Object.freeze([
  'Threads kept in another browser are not visible here.',
  'A long thread is read in its newest part; coverage says how far back.',
])

/** The only access the reader has to the store: no write, no fetch. */
export interface ThreadStoreView {
  /** Names in a directory, or [] when it is absent. */
  readonly list: (dir: string) => readonly string[]
  /** Size, modification time and kind, or null when absent. */
  readonly stat: (path: string) => { size: number; mtimeMs: number; dir: boolean } | null
  /** Bytes [position, position+length) of a file; a view the caller must never write into. */
  readonly read: (path: string, position: number, length: number) => Uint8Array
}

/** Bytes read so far against a budget. */
interface Meter { read: number; left: number }

const privatePath = (path: string): boolean => path === PRIVATE_ROOT || path.startsWith(PRIVATE_ROOT + '/')

/**
 * Wrap the tab filesystem as a read-only view. A read under /dsh/home/auma/private throws before the store is touched.
 * @param vfs - this tab's filesystem (only stat, readdir and read are used).
 * @param counter - optional running count of bytes handed out, for budgets and tests.
 * @returns the view.
 */
export function threadStoreView(vfs: Pick<MemoryVfs, 'statSync' | 'readdirSync' | 'readFileSync'>,
  counter?: { bytes: number }): ThreadStoreView {
  return Object.freeze({
    list: (dir: string): readonly string[] => {
      if (privatePath(dir)) return []
      try { return vfs.readdirSync(dir).map(String) } catch { return [] }
    },
    stat: (path: string) => {
      try {
        const stat = vfs.statSync(path) as { size: number; mtimeMs: number; isDirectory(): boolean }
        return { size: stat.size, mtimeMs: stat.mtimeMs, dir: stat.isDirectory() }
      } catch { return null }
    },
    read: (path: string, position: number, length: number): Uint8Array => {
      if (privatePath(path)) throw new Error('THREADS_PRIVATE_NOT_OPENED')
      const raw = vfs.readFileSync(path)
      const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw
      const view = bytes.subarray(Math.max(0, position), Math.max(0, position) + Math.max(0, length))
      if (counter) counter.bytes += view.byteLength
      return view
    },
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery

const CANONICAL_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/
const COMPRESSED_LOG = /^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd$/

export interface ThreadFile {
  readonly id: string
  readonly dir: string
  readonly path: string | null
  readonly size: number
  readonly mtimeMs: number
  readonly project: string
  readonly workspace: string | null
  readonly withheld: 'private' | 'compressed' | null
}

/**
 * Every thread in this browser, newest first: each session directory under each project directory, its highest
 * canonical `session[.vN].jsonl` generation. A project whose working folder is the private folder is not opened.
 * @param view - read-only store view.
 * @returns threads and whether the walk stopped at its cap.
 */
export function discoverThreads(view: ThreadStoreView): { threads: ThreadFile[]; truncated: boolean } {
  const threads: ThreadFile[] = []
  let truncated = false
  for (const project of [...view.list(SESSIONS_ROOT)].sort()) {
    const projectPath = `${SESSIONS_ROOT}/${project}`
    if (!view.stat(projectPath)?.dir) continue
    const decoded = decodeSessionWorkspace(project)
    const projectIsPrivate = privateProject(project)
    for (const session of [...view.list(projectPath)].sort()) {
      if (threads.length >= THREAD_LIMITS.discoverThreads) { truncated = true; break }
      const dir = `${projectPath}/${session}`
      const dirStat = view.stat(dir)
      if (!dirStat?.dir) continue
      if (projectIsPrivate) {
        threads.push({ id: session, dir, path: null, size: 0, mtimeMs: dirStat.mtimeMs, project, workspace: decoded.workspace, withheld: 'private' })
        continue
      }
      let best: { name: string; version: number } | null = null
      let compressed = false
      for (const name of view.list(dir)) {
        const match = CANONICAL_LOG.exec(name)
        if (match) {
          const version = match[1] === undefined ? 0 : Number(match[1])
          if (!best || version > best.version) best = { name, version }
        } else if (COMPRESSED_LOG.test(name)) compressed = true
      }
      if (!best) {
        if (compressed) threads.push({ id: session, dir, path: null, size: 0, mtimeMs: dirStat.mtimeMs, project, workspace: decoded.workspace, withheld: 'compressed' })
        continue
      }
      const path = `${dir}/${best.name}`
      const stat = view.stat(path)
      if (!stat || stat.dir) continue
      threads.push({ id: session, dir, path, size: stat.size, mtimeMs: stat.mtimeMs, project, workspace: decoded.workspace,
        withheld: null })
    }
    if (truncated) break
  }
  threads.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1))
  return { threads, truncated }
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading lines from the end

const NEWLINE = 0x0a
const decoder = new TextDecoder()

/** A fresh array holding `a` then `b`; neither input is written. */
function joined(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

interface WindowState { bytesRead: number; fromByte: number; reachedStart: boolean }

/**
 * Yield whole lines from the end of a file towards its start, newest first. The window starts at `firstBytes` and
 * doubles each time more is needed, never past `maxBytes` for this file nor the shared meter's budget. A line that
 * begins before the window is not yielded.
 */
function* linesFromEnd(view: ThreadStoreView, path: string, size: number, firstBytes: number, maxBytes: number,
  meter: Meter, state: WindowState): Generator<Uint8Array> {
  let end = size
  // The front of the newest piece read so far: the end of a line that begins further back. Held in a box so it is never
  // mistaken for a constant; every join is a fresh copy, so no read buffer is written.
  const carry: { bytes: Uint8Array | null } = { bytes: null }
  let chunk = Math.min(firstBytes, maxBytes)
  state.fromByte = size
  if (size === 0) { state.reachedStart = true; return }
  while (end > 0) {
    const allowed = Math.min(chunk, maxBytes - state.bytesRead, meter.left)
    if (allowed <= 0) break
    const start = Math.max(0, end - allowed)
    const bytes = view.read(path, start, end - start)
    state.bytesRead += bytes.byteLength
    meter.read += bytes.byteLength
    meter.left -= bytes.byteLength
    state.fromByte = start
    let lineEnd = bytes.byteLength
    for (let at = bytes.byteLength - 1; at >= 0; at -= 1) {
      if (bytes[at] !== NEWLINE) continue
      const piece = bytes.subarray(at + 1, lineEnd)
      const line = carry.bytes ? joined(piece, carry.bytes) : piece
      carry.bytes = null
      lineEnd = at
      if (line.byteLength > 0) yield line
    }
    const rest = bytes.subarray(0, lineEnd)
    carry.bytes = carry.bytes ? joined(rest, carry.bytes) : rest
    end = start
    if (end === 0) {
      state.reachedStart = true
      if (carry.bytes.byteLength > 0) yield carry.bytes
      return
    }
    chunk = state.bytesRead
  }
}

const WANTED = new Set(['user/message', 'assistant/message', 'tool/call', 'session/title', 'turn/start', 'turn/end'])

// ---------------------------------------------------------------------------------------------------------------------
// Byte scan for a title in the head of a large file

const TITLE_NEEDLE = new TextEncoder().encode('session/title"')
const TITLE_ROWS: ReadonlySet<string> = new Set(['session/title'])

function lastIndexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  const first = needle[0] as number
  let found = -1
  let at = hay.indexOf(first)
  while (at >= 0 && at + needle.byteLength <= hay.byteLength) {
    let same = true
    for (let k = 1; k < needle.byteLength; k += 1) if (hay[at + k] !== needle[k]) { same = false; break }
    if (same) found = at
    at = hay.indexOf(first, at + 1)
  }
  return found
}

/**
 * Scan the head of a file for its newest title row. `reached` says whether, together with a tail window that starts at
 * `tailFrom`, every row of the file was looked at: either the head is the whole file, or it holds the end of the row the
 * tail window opens inside (the tail yields only rows that begin after its first line break). When a title is not found
 * and `reached` is false, the file's middle was never read, so the thread is not known to be untitled.
 */
function headTitle(view: ThreadStoreView, thread: ThreadFile, meter: Meter, probeBytes: number,
  tailFrom: number): { title: string | null; reached: boolean } {
  if (!thread.path) return { title: null, reached: false }
  const length = Math.min(thread.size, probeBytes, meter.left)
  if (length <= 0) return { title: null, reached: false }
  const head = view.read(thread.path, 0, length)
  meter.read += head.byteLength
  meter.left -= head.byteLength
  const reached = head.byteLength >= thread.size || head.indexOf(NEWLINE, tailFrom) >= 0
  let hay = head
  for (;;) {
    const at = lastIndexOfBytes(hay, TITLE_NEEDLE)
    if (at < 0) return { title: null, reached }
    const start = hay.lastIndexOf(NEWLINE, at) + 1
    const end = hay.indexOf(NEWLINE, at)
    if (end >= 0) {
      const row = parseRow(hay.subarray(start, end), TITLE_ROWS)
      const title = row ? titleOf(row) : null
      if (title !== null) return { title, reached }
    }
    if (start === 0) return { title: null, reached }
    hay = hay.subarray(0, start - 1)
  }
}

function headerOf(view: ThreadStoreView, thread: ThreadFile, meter: Meter): Record<string, unknown> | null {
  if (!thread.path) return null
  const length = Math.min(thread.size, THREAD_LIMITS.headerBytes, meter.left)
  if (length <= 0) return null
  const head = view.read(thread.path, 0, length)
  meter.read += head.byteLength
  meter.left -= head.byteLength
  const end = head.indexOf(NEWLINE)
  try {
    const parsed: unknown = JSON.parse(decoder.decode(end >= 0 ? head.subarray(0, end) : head))
    return record(parsed) && parsed.type === 'session' ? parsed : null
  } catch { return null }
}

// ---------------------------------------------------------------------------------------------------------------------
// Answers

const sizeOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

const base = (action: ThreadAction): Record<string, unknown> => ({
  ok: true, schema: 'aukora.threads.v1', action, readOnly: true, voiceAuthority: 'none',
})

function refuse(code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, code, message, readOnly: true, ...extra }
}

const intIn = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(Math.max(value, min), max) : fallback

const shortId = (id: string): string => id.slice(0, 24)

/** Find one thread by its exact id, or by a unique prefix of at least four characters. */
function resolveThread(threads: readonly ThreadFile[], wanted: unknown): ThreadFile | Record<string, unknown> {
  if (typeof wanted !== 'string' || !wanted.trim()) return refuse('THREAD_REQUIRED', 'Name a thread: an id from `list`.')
  const key = wanted.trim()
  const exact = threads.find(thread => thread.id === key)
  if (exact) return exact
  const matches = key.length >= 4 ? threads.filter(thread => thread.id.startsWith(key)) : []
  if (matches.length === 1) return matches[0] as ThreadFile
  if (matches.length > 1) return refuse('THREAD_AMBIGUOUS', 'More than one thread starts with that; use a longer id.', { candidates: matches.slice(0, 5).map(thread => thread.id) })
  return refuse('THREAD_NOT_FOUND', 'No thread in this browser has that id. Threads kept in another browser are not visible here.')
}

/** Why a thread's title is not known: the shared budget cut its head scan short, or a full scan did not reach its tail. */
type TitleNotRead = 'budget' | 'probe'

interface Brief { title: string | null; titleFrom: 'tail' | 'head' | null; titleNotRead: TitleNotRead | null; he: Words | null; heAt: number | null; she: Words | null; sheAt: number | null; activeAt: number | null; blank: boolean }

/**
 * Read one thread's last 64 KiB (and, for a missing title, a byte scan of its head). The head scan only spends what is
 * left over after `reserveAfter`, the header and tail bytes still owed to the threads listed after this one.
 */
function briefOf(view: ThreadStoreView, thread: ThreadFile, meter: Meter, reserveAfter: number): Brief {
  const brief: Brief = { title: null, titleFrom: null, titleNotRead: null, he: null, heAt: null, she: null, sheAt: null,
    activeAt: null, blank: false }
  if (!thread.path) return brief
  const state: WindowState = { bytesRead: 0, fromByte: thread.size, reachedStart: false }
  let sawTurn = false
  for (const line of linesFromEnd(view, thread.path, thread.size, THREAD_LIMITS.listTailBytes, THREAD_LIMITS.listTailBytes, meter, state)) {
    const row = parseRow(line, WANTED)
    if (!row) continue
    if (brief.activeAt === null && row.time !== null) brief.activeAt = row.time
    if (row.type === 'turn/start') sawTurn = true
    if (brief.title === null) {
      const title = titleOf(row)
      if (title !== null) { brief.title = title; brief.titleFrom = 'tail' }
    }
    const words = wordsOf(row)
    if (!words || !words.text) continue
    if (words.who === 'he' && !brief.he) { brief.he = words; brief.heAt = row.time }
    if (words.who === 'she' && !brief.she) { brief.she = words; brief.sheAt = row.time }
  }
  brief.blank = state.reachedStart && !sawTurn
  if (brief.title === null && !state.reachedStart) {
    const probe = Math.max(0, Math.min(THREAD_LIMITS.listTitleProbeBytes, meter.left - reserveAfter))
    const head = probe > 0 ? headTitle(view, thread, meter, probe, state.fromByte) : { title: null, reached: false }
    if (head.title !== null) { brief.title = head.title; brief.titleFrom = 'head' }
    // Not found and the file's middle was never read: say why, never an unmarked `title: null`.
    else if (!head.reached) brief.titleNotRead = probe < Math.min(thread.size, THREAD_LIMITS.listTitleProbeBytes) ? 'budget' : 'probe'
  }
  return brief
}

/** Bytes a listed thread is owed before any head scan: its header and its whole tail window. */
const listBaseBytes = (thread: ThreadFile): number => (thread.withheld || !thread.path ? 0
  : Math.min(thread.size, THREAD_LIMITS.headerBytes) + Math.min(thread.size, THREAD_LIMITS.listTailBytes))

function listThreads(view: ThreadStoreView, threads: readonly ThreadFile[], truncated: boolean, now: number,
  meter: Meter): Record<string, unknown> {
  const rows: Array<Record<string, unknown>> = []
  const listed = threads.slice(0, THREAD_LIMITS.listThreads)
  // owedAfter[i]: header and tail bytes still owed to the threads listed after thread i. A head scan for a title only
  // spends what is left over, so a title probe never starves a later thread of its tail.
  const owedAfter: number[] = new Array<number>(listed.length + 1).fill(0)
  for (let index = listed.length - 1; index >= 0; index -= 1) {
    owedAfter[index] = (owedAfter[index + 1] as number) + listBaseBytes(listed[index] as ThreadFile)
  }
  let spent = false
  for (const [index, thread] of listed.entries()) {
    const row: Record<string, unknown> = { id: shortId(thread.id), bytes: thread.size }
    if (thread.withheld) {
      row.withheld = thread.withheld
      row.agoMin = Math.max(0, Math.floor((now - thread.mtimeMs) / 60_000))
      rows.push(row)
      continue
    }
    // Once the budget cannot give a thread its header and whole tail, that row and every row after it say so plainly:
    // a row that was not read must never look like an untitled, empty thread.
    if (spent || meter.left < listBaseBytes(thread)) {
      spent = true
      rows.push({ ...row, agoMin: Math.max(0, Math.floor((now - thread.mtimeMs) / 60_000)), notRead: 'budget' })
      continue
    }
    const header = headerOfSafe(view, thread, meter)
    if (typeof header?.cwd === 'string' && privatePath(header.cwd)) { rows.push({ ...row, withheld: 'private' }); continue }
    let brief: Brief
    try { brief = briefOf(view, thread, meter, owedAfter[index + 1] as number) } catch { rows.push({ ...row, unreadable: true }); continue }
    const activeAt = Math.max(brief.activeAt ?? 0, thread.mtimeMs)
    row.title = brief.title
    if (brief.titleNotRead) row.titleNotRead = brief.titleNotRead
    row.agoMin = Math.max(0, Math.floor((now - activeAt) / 60_000))
    if (brief.title === VOICE_THREAD_TITLE) row.voice = true
    if (brief.blank) row.blank = true
    if (header?.origin === 'subagent') row.subagent = true
    if (brief.he) row.he = cut(brief.he.text, THREAD_LIMITS.listLineChars)
    if (brief.she) row.she = cut(brief.she.text, THREAD_LIMITS.listLineChars)
    rows.push(row)
  }
  const answer: Record<string, unknown> = {
    ...base('list'), total: threads.length, listed: rows.length, threads: rows,
    ...(threads.length > rows.length || truncated ? { more: threads.length - rows.length, walkTruncated: truncated } : {}),
    bytesRead: meter.read, sources: SOURCES, gaps: GAPS,
  }
  // Fit the answer: drop the oldest rows' lines first, then the oldest rows; the voice thread's row is dropped last.
  const trims: string[] = []
  const settle = (): number => { answer.listed = rows.length; if (trims.length) answer.trimmed = trims; return sizeOf(answer) }
  for (let index = rows.length - 1; index >= 0 && settle() > THREAD_LIMITS.listAnswerBytes; index -= 1) {
    const row = rows[index] as Record<string, unknown>
    if ('he' in row || 'she' in row) { delete row.he; delete row.she; if (!trims.includes('lines')) trims.push('lines') }
  }
  while (rows.length > 0 && settle() > THREAD_LIMITS.listAnswerBytes) {
    let oldestOther = rows.length - 1
    while (oldestOther > 0 && (rows[oldestOther] as Record<string, unknown>).voice === true) oldestOther -= 1
    rows.splice(oldestOther, 1)
    if (!trims.includes('rows')) trims.push('rows')
  }
  settle()
  return answer
}

function headerOfSafe(view: ThreadStoreView, thread: ThreadFile, meter: Meter): Record<string, unknown> | null {
  try { return headerOf(view, thread, meter) } catch { return null }
}

interface Turn { turn: number | null; at: number | null; he: string[]; she: string[]; tools: string[]; spoken: boolean; started: boolean }

function tailThread(view: ThreadStoreView, thread: ThreadFile, wantedTurns: number, meter: Meter): Record<string, unknown> {
  const head: Record<string, unknown> = { id: thread.id, bytes: thread.size }
  if (thread.withheld === 'private' || !thread.path) {
    return refuse(thread.withheld === 'private' ? 'THREAD_PRIVATE' : 'THREAD_UNREADABLE',
      thread.withheld === 'private' ? 'That thread works in my private folder; I do not open it here.' : 'That thread is stored compressed; I cannot read it here.', { thread: head })
  }
  const header = headerOfSafe(view, thread, meter)
  if (typeof header?.cwd === 'string' && privatePath(header.cwd)) {
    return refuse('THREAD_PRIVATE', 'That thread works in my private folder; I do not open it here.', { thread: head })
  }
  const state: WindowState = { bytesRead: 0, fromByte: thread.size, reachedStart: false }
  // Rows arrive newest first. A turn is opened by its last row (turn/end, her reply, a tool call, or his words while it
  // runs) and closed by its turn/start; his words carry no turn number and belong to the turn that is open.
  const turns: Turn[] = []
  const cursor: { open: Turn | null } = { open: null }
  let starts = 0
  let title: string | null = null
  let titleNotRead: TitleNotRead | null = null
  const attach = (number: number | null): Turn => {
    const open = cursor.open
    if (open && (number === null || open.turn === null || open.turn === number)) {
      if (open.turn === null) open.turn = number
      return open
    }
    const next: Turn = { turn: number, at: null, he: [], she: [], tools: [], spoken: false, started: false }
    turns.push(next)
    cursor.open = next
    return next
  }
  const turnNumber = (row: Row): number | null => (Number.isSafeInteger(row.data.turn) ? row.data.turn as number : null)
  for (const line of linesFromEnd(view, thread.path, thread.size, THREAD_LIMITS.tailFirstBytes, THREAD_LIMITS.tailMaxBytes, meter, state)) {
    const row = parseRow(line, WANTED)
    if (!row) continue
    if (title === null) title = titleOf(row)
    if (row.type === 'turn/end') { attach(turnNumber(row)); continue }
    if (row.type === 'turn/start') {
      const open = cursor.open
      const number = turnNumber(row)
      if (open && (open.turn === null || open.turn === number)) {
        open.turn = number
        open.started = true
        if (row.time !== null) open.at = row.time
        starts += 1
      }
      cursor.open = null
      if (starts >= wantedTurns) break
      continue
    }
    if (row.type === 'tool/call') {
      const turn = attach(turnNumber(row))
      const name = typeof row.data.name === 'string' ? row.data.name.slice(0, 64) : ''
      if (name && !turn.tools.includes(name)) turn.tools.unshift(name)
      continue
    }
    const words = wordsOf(row)
    if (!words) continue
    const turn = attach(words.who === 'she' ? words.turn : null)
    if (row.time !== null) turn.at = row.time
    for (const name of words.tools) if (!turn.tools.includes(name)) turn.tools.unshift(name)
    if (words.spoken) turn.spoken = true
    if (words.text) (words.who === 'he' ? turn.he : turn.she).unshift(words.text)
  }
  if (title === null && !state.reachedStart) {
    const head = headTitle(view, thread, meter, THREAD_LIMITS.tailTitleProbeBytes, state.fromByte)
    title = head.title
    if (title === null && !head.reached) titleNotRead = 'probe'
  }
  const shown = turns.filter(turn => turn.he.length || turn.she.length || turn.tools.length).slice(0, wantedTurns).reverse().map((turn) => {
    const he = cut(turn.he.join(' '), THREAD_LIMITS.tailHeChars)
    const she = cut(turn.she.join(' '), THREAD_LIMITS.tailTurnChars - he.length)
    return {
      turn: turn.turn, at: turn.at, ...(he ? { he } : {}), ...(she ? { she } : {}),
      ...(turn.tools.length ? { tools: turn.tools.slice(0, 24) } : {}),
      ...(turn.spoken ? { spoken: true } : {}), ...(turn.started ? {} : { partial: true }),
    }
  })
  const answer: Record<string, unknown> = {
    ...base('tail'), thread: { ...head, title, ...(titleNotRead ? { titleNotRead } : {}), ...(title === VOICE_THREAD_TITLE ? { voice: true } : {}) },
    turns: shown,
    coverage: { bytesRead: state.bytesRead, fromByte: state.fromByte, bytes: thread.size, reachedStart: state.reachedStart },
    sources: SOURCES, gaps: GAPS,
  }
  const trims: string[] = []
  const settle = (): number => { if (trims.length) answer.trimmed = trims; return sizeOf(answer) }
  while (shown.length > 0 && settle() > THREAD_LIMITS.tailAnswerBytes) {
    shown.shift()
    if (!trims.includes('oldest-turns')) trims.push('oldest-turns')
  }
  if (trims.length) answer.trimmed = trims
  return answer
}

function searchThreads(view: ThreadStoreView, threads: readonly ThreadFile[], query: unknown, only: ThreadFile | null,
  meter: Meter): Record<string, unknown> {
  if (typeof query !== 'string' || !query.trim() || query.length > THREAD_LIMITS.searchQueryChars) {
    return refuse('THREADS_QUERY_INVALID', `Give a literal phrase of 1 to ${String(THREAD_LIMITS.searchQueryChars)} characters.`)
  }
  const needle = query.toLowerCase()
  const raw = rawNeedle(query)
  const hits: Array<Record<string, unknown>> = []
  const coverage: Array<Record<string, unknown>> = []
  let stoppedAt: 'hits' | 'budget' | null = null
  for (const thread of only ? [only] : threads) {
    const row: Record<string, unknown> = { id: shortId(thread.id), bytes: thread.size }
    if (thread.withheld || !thread.path) { coverage.push({ ...row, searched: 0, withheld: thread.withheld ?? 'unreadable' }); continue }
    if (stoppedAt) { coverage.push({ ...row, searched: 0, notSearched: stoppedAt }); continue }
    if (meter.left <= 0) { stoppedAt = 'budget'; coverage.push({ ...row, searched: 0, notSearched: 'budget' }); continue }
    const header = headerOfSafe(view, thread, meter)
    if (typeof header?.cwd === 'string' && privatePath(header.cwd)) { coverage.push({ ...row, searched: 0, withheld: 'private' }); continue }
    const state: WindowState = { bytesRead: 0, fromByte: thread.size, reachedStart: false }
    let found = 0
    try {
      const lines = linesFromEnd(view, thread.path, thread.size, THREAD_LIMITS.searchFirstBytes, THREAD_LIMITS.searchFileBytes,
        meter, state)
      for (const line of lines) {
        const type = rowType(line)
        if (type !== null && type !== 'user/message' && type !== 'assistant/message') continue
        const text = decoder.decode(line)
        if (!text.toLowerCase().includes(raw)) continue
        const parsed = parseRow(line, WANTED)
        const words = parsed ? wordsOf(parsed) : null
        if (!words || !words.text) continue
        const lower = words.text.toLowerCase()
        const at = lower.indexOf(needle)
        if (at < 0) continue
        const half = Math.floor((THREAD_LIMITS.searchSnippetChars - needle.length) / 2)
        const start = Math.max(0, at - Math.max(0, half))
        const snippet = words.text.slice(start, start + THREAD_LIMITS.searchSnippetChars)
        hits.push({ thread: shortId(thread.id), who: words.who, at: parsed?.time ?? null, snippet: `${start > 0 ? '…' : ''}${snippet}` })
        found += 1
        if (hits.length >= THREAD_LIMITS.searchHits) { stoppedAt = 'hits'; break }
      }
    } catch { coverage.push({ ...row, searched: state.bytesRead, unreadable: true }); continue }
    coverage.push({ ...row, searched: state.bytesRead, ...(state.reachedStart ? {} : { partial: true }),
      ...(found ? { hits: found } : {}) })
    if (!stoppedAt && meter.left <= 0) stoppedAt = 'budget'
  }
  const answer: Record<string, unknown> = {
    ...base('search'), query: withholdSecrets(query), hits, coverage, ...(stoppedAt ? { stoppedAt } : {}),
    bytesRead: meter.read,
    limits: { perThreadBytes: THREAD_LIMITS.searchFileBytes, totalBytes: THREAD_LIMITS.searchTotalBytes, hits: THREAD_LIMITS.searchHits },
    sources: SOURCES, gaps: GAPS,
  }
  // Fit: drop coverage rows of threads with no hits, oldest first; then the oldest hits.
  const trims: string[] = []
  let omitted = 0
  const settle = (): number => {
    if (omitted) answer.coverageOmitted = omitted
    if (trims.length) answer.trimmed = trims
    return sizeOf(answer)
  }
  for (let index = coverage.length - 1; index >= 0 && settle() > THREAD_LIMITS.searchAnswerBytes; index -= 1) {
    if ((coverage[index] as Record<string, unknown>).hits) continue
    coverage.splice(index, 1)
    omitted += 1
    if (!trims.includes('coverage')) trims.push('coverage')
  }
  while (hits.length > 0 && settle() > THREAD_LIMITS.searchAnswerBytes) {
    hits.pop()
    if (!trims.includes('hits')) trims.push('hits')
  }
  if (trims.length) answer.trimmed = trims
  return answer
}

/**
 * Answer one `x6_threads` call. Read-only and bounded; never throws for a bad argument (it answers `ok: false`).
 * @param view - read-only store view.
 * @param args - `{ action: 'list' | 'tail' | 'search', thread?, turns?, query? }`; `action` is required and exact.
 * @param now - clock for "minutes ago".
 * @param lower - a caller may LOWER the `list` byte budget (never raise it: a larger figure is clamped).
 * @returns a JSON-safe answer within the action's byte bound.
 */
export function readThreads(view: ThreadStoreView, args: unknown, now: number = Date.now(),
  lower: { listTotalBytes?: number } = {}): Record<string, unknown> {
  const input = record(args) ? args : {}
  const action = input.action
  if (typeof action !== 'string' || !(THREAD_ACTIONS as readonly string[]).includes(action)) {
    return refuse('THREADS_ACTION_REQUIRED', 'Say which: action "list", "tail" or "search".', { actions: THREAD_ACTIONS })
  }
  try {
    const { threads, truncated } = discoverThreads(view)
    if (action === 'list') {
      const budget = intIn(lower.listTotalBytes, THREAD_LIMITS.listTotalBytes, 0, THREAD_LIMITS.listTotalBytes)
      return listThreads(view, threads, truncated, now, { read: 0, left: budget })
    }
    if (action === 'tail') {
      const found = resolveThread(threads, input.thread)
      if (!('path' in found)) return found
      return tailThread(view, found as ThreadFile, intIn(input.turns, THREAD_LIMITS.tailDefaultTurns, 1, THREAD_LIMITS.tailMaxTurns),
        { read: 0, left: THREAD_LIMITS.tailMaxBytes + THREAD_LIMITS.headerBytes + THREAD_LIMITS.tailTitleProbeBytes })
    }
    let only: ThreadFile | null = null
    if (input.thread !== undefined) {
      const found = resolveThread(threads, input.thread)
      if (!('path' in found)) return found
      only = found as ThreadFile
    }
    return searchThreads(view, threads, input.query, only, { read: 0, left: THREAD_LIMITS.searchTotalBytes })
  } catch (error) {
    return refuse('THREADS_READ_FAILED', 'I could not read my threads just now.',
      { error: withholdSecrets((error instanceof Error ? error.message : String(error)).slice(0, 160)) })
  }
}

/**
 * Register `x6_threads` through the loader's own built-in registration (ball-loader adds the one call).
 * @param register - the loader's `registerBuiltin`.
 * @param options - the tab filesystem and the loader's JSON output renderer.
 */
export function registerThreadTools(register: (spec: Record<string, unknown> & { name: string }) => void,
  options: { vfs: Pick<MemoryVfs, 'statSync' | 'readdirSync' | 'readFileSync'>; output: unknown; now?: () => number }): void {
  register({
    name: 'x6_threads',
    description: 'Read-only, tail-first reader of every thread kept in this browser. `action` is required: `list` (every thread, '
      + 'newest first: id, title, size, minutes since active, the last line he and you said; voice and blank threads marked), '
      + '`tail` (one thread\'s last turns, his and your words only, tool calls by name), `search` (a literal phrase in the newest '
      + '4 MiB of each thread, newest first; `coverage` says how far back each thread was searched). It carries text from other '
      + 'threads into this one; secret-shaped text comes back as [withheld] and the private folder is never opened. Threads in '
      + 'another browser are not visible here. It writes nothing, stages nothing and fetches nothing.',
    parameters: {
      action: { type: 'string', required: true, enum: [...THREAD_ACTIONS], description: '`list`, `tail` or `search`; required.' },
      thread: { type: 'string', description: '`tail` (required) and `search` (optional): a thread id from `list`, or a unique prefix of at least 4 characters.' },
      turns: { type: 'number', description: '`tail`: turns to return, 1..12 (default 6).' },
      query: { type: 'string', description: '`search`: a literal, case-insensitive phrase of 1..128 characters.' },
    },
    output: options.output,
    execute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      return Promise.resolve(readThreads(threadStoreView(options.vfs), args, options.now ? options.now() : Date.now()))
    },
  })
}
