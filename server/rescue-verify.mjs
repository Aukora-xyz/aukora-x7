#!/usr/bin/env node
/**
 * Check an `x61-rescue-pack/v1` file made by the rescue kit's "Save a copy on this computer", and (optionally) turn it
 * back into files:
 *   node server/rescue-verify.mjs <pack> [--expect-id <id>] [--allow-empty] [--extract <new empty folder> [--extract-incomplete]]
 * Layout: the 11 bytes `X61RESCUE1\n`, the row bytes one after another, the index (canonical JSON: the kit's index plus
 * `offset` per row), an 8-byte big-endian index length, the 11 bytes again.
 *
 * The index is PINNED: its id (the kit's own `indexId`, imported from rescue-kit.mjs, so the two can never disagree) is
 * printed and must equal the id in the file name and the `--expect-id` given. The index must be canonical (no byte after
 * it, nothing reordered or repeated), v 1, piece 2,097,152, a known source, keys unique and in order. Every row is then
 * re-hashed (whole and per piece) as one stream. A pack that records anything its run could not copy (unreadable,
 * missing, changed, vanished or new rows, or a listing that failed: `unlisted`), that says it checked fewer rows again
 * than it holds (`completeness.rechecked`), or that records less than this (an older kit), is NOT COMPLETE.
 *
 * Saved-setting rows: Auma Live's chat logs (the kit's own allow-list, `kit.isChatLog`) are in every pack made by this
 * kit; any OTHER saved setting only in a pack whose `completeness.settings` is true. Their count is printed.
 * Prints counts, the main thread (by its session folder's last two parts), save times, and each mismatch by key with her
 * private folder shown as `/dsh/home/auma/private/[redacted]`. Never contents.
 * Exit 0 every row matches and the run was complete; 1 a mismatch, an id that differs or is not pinned, an empty pack
 * (without --allow-empty), or an extract that could not write every file; 2 not a pack (or bad arguments); 3 the rows
 * match but the run was NOT COMPLETE.
 * @module rescue-verify
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, utimes } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rescueKit } from '../deploy/cloudflare/src/rescue-kit.mjs'

const kit = rescueKit({ indexedDB: null, localStorage: null })
const MAGIC = Buffer.from('X61RESCUE1\n')
const PROTOCOL_PIECE = 2097152
const MAX_INDEX_BYTES = 64 * 1024 * 1024
const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[0-9a-f]{32}$/
const EMPTY_SHA256 = createHash('sha256').digest('hex')
const BYTE_TYPES = new Set(['file', 'meta', 'local'])
const SOURCES = new Set(['indexeddb', 'memory'])
const TOP_FIELDS = new Set(['v', 'piece', 'source', 'client', 'rows', 'skipped', 'totals', 'completeness', 'unlisted'])
const ROW_FIELDS = {
  file: ['key', 'type', 'mode', 'mtimeMs', 'bytes', 'sha256', 'pieces', 'offset'],
  dir: ['key', 'type', 'mode', 'bytes', 'sha256', 'pieces', 'offset'],
  gone: ['key', 'type', 'bytes', 'sha256', 'pieces', 'offset'],
  meta: ['key', 'type', 'bytes', 'sha256', 'pieces', 'offset'],
  local: ['key', 'type', 'bytes', 'sha256', 'pieces', 'offset'],
}
const COMPLETENESS_FIELDS = ['changed', 'grew', 'missing', 'newRows', 'rechecked', 'settings', 'unreadable', 'vanished']
/** The record an older kit wrote: no `rechecked`, no `unlisted` beside it. Read, and never complete. */
const OLDER_COMPLETENESS_FIELDS = ['changed', 'grew', 'missing', 'newRows', 'settings', 'unreadable', 'vanished']
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const hhmm = ms => {
  const date = new Date(ms)
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
}

/** Not a pack this tool can trust at all: exit 2. */
class NotAPack extends Error {}

/** Read the trailer and the index, and refuse anything that is not exactly a canonical v1 index. */
async function readIndex(path) {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size < MAGIC.length * 2 + 8) throw new NotAPack('too short to be a rescue pack')
    const head = Buffer.alloc(MAGIC.length), tail = Buffer.alloc(MAGIC.length + 8)
    await handle.read(head, 0, head.length, 0)
    await handle.read(tail, 0, tail.length, size - tail.length)
    if (!head.equals(MAGIC) || !tail.subarray(8).equals(MAGIC)) throw new NotAPack('not an x61-rescue-pack/v1 file')
    const length = tail.readBigUInt64BE(0)
    const indexStart = BigInt(size) - BigInt(tail.length) - length
    if (indexStart < BigInt(MAGIC.length)) throw new NotAPack('index length runs past the start of the file')
    if (length > BigInt(MAX_INDEX_BYTES)) throw new NotAPack('the index is larger than any kit writes')
    const bytes = Buffer.alloc(Number(length))
    await handle.read(bytes, 0, bytes.length, Number(indexStart))
    let text, index
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new NotAPack('the index is not UTF-8') }
    try { index = JSON.parse(text) } catch { throw new NotAPack('the index is not JSON') }
    if (!isRecord(index)) throw new NotAPack('the index is not an object')
    // Byte for byte the kit's canonical form: catches bytes after the index, reordered or repeated names, any spacing.
    if (kit.canon(index) !== text) throw new NotAPack('the index is not in the canonical form the kit writes (bytes after it, or names reordered, repeated or spaced)')
    if (index.v !== 1) throw new NotAPack('not a v1 rescue index')
    if (index.piece !== PROTOCOL_PIECE) throw new NotAPack('the piece size is not 2097152')
    if (!SOURCES.has(index.source)) throw new NotAPack('an unknown source')
    const unknown = Object.keys(index).filter(name => !TOP_FIELDS.has(name))
    if (unknown.length > 0) throw new NotAPack('the index has fields no kit writes')
    if (!Array.isArray(index.rows) || !isRecord(index.totals) || !Array.isArray(index.skipped) || !isRecord(index.client)) {
      throw new NotAPack('the index lacks rows, totals, skipped or client')
    }
    return { index, text, dataEnd: Number(indexStart) }
  } finally { await handle.close() }
}

/** Is `{count, shapes}` well formed: shapes sorted, each counted at least once, summing to count? */
function countedShape(u) {
  if (!isRecord(u) || Object.keys(u).sort().join(',') !== 'count,shapes' || !count(u.count) || !Array.isArray(u.shapes)) return false
  let sum = 0
  for (let at = 0; at < u.shapes.length; at++) {
    const entry = u.shapes[at]
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'count,shape' || typeof entry.shape !== 'string'
      || !Number.isSafeInteger(entry.count) || entry.count < 1) return false
    if (at > 0 && !(u.shapes[at - 1].shape < entry.shape)) return false
    sum += entry.count
  }
  return sum === u.count
}
/** Is the recorded `completeness` well formed (`fields`: this kit's, or an older kit's)? */
function completenessShape(c, fields = COMPLETENESS_FIELDS) {
  if (!isRecord(c) || Object.keys(c).sort().join(',') !== fields.join(',')) return false
  if (typeof c.settings !== 'boolean' || ![c.missing, c.newRows, c.grew, c.changed, c.vanished].every(count)) return false
  if (fields === COMPLETENESS_FIELDS && !count(c.rechecked)) return false
  return countedShape(c.unreadable)
}

/**
 * Verify a pack.
 * @param {string} path - the pack file.
 * @param {{expectId?: string|null, allowEmpty?: boolean}} [options]
 * @returns {Promise<{ok: boolean, complete: boolean, code: number, id: string, lines: string[], mismatches: Array<{key: string, reason: string}>, index: object, dataEnd: number}>}
 */
export async function verifyRescuePack(path, options = {}) {
  const { index, text, dataEnd } = await readIndex(path)
  const piece = index.piece
  const mismatches = []
  const wrong = (key, reason) => { mismatches.push({ key: kit.shown(String(key)), reason }) }
  const counts = { file: 0, dir: 0, gone: 0, meta: 0, local: 0 }
  let chatLogs = 0
  const queue = []
  let threads = 0, homeFiles = 0, bytes = 0, newest = null, mainThread = null
  for (let at = 0; at < index.rows.length; at++) {
    const row = index.rows[at]
    if (!isRecord(row) || typeof row.key !== 'string' || !(row.type in counts)) { wrong(isRecord(row) && typeof row.key === 'string' ? row.key : '(no key)', 'row shape'); continue }
    const before = index.rows[at - 1]
    if (at > 0 && isRecord(before) && typeof before.key === 'string') {
      if (before.key === row.key) wrong(row.key, 'duplicate key')
      else if (!(before.key < row.key)) wrong(row.key, 'key out of order')
    }
    counts[row.type] += 1
    if (row.type === 'local' && kit.isChatLog(row.key.slice('localStorage:'.length))) chatLogs += 1
    const allowed = ROW_FIELDS[row.type]
    if (Object.keys(row).some(name => !allowed.includes(name)) || allowed.some(name => !(name in row)) || !Number.isSafeInteger(row.offset)
      || row.offset < MAGIC.length || ((row.type === 'file' || row.type === 'dir') && row.mode !== null && !Number.isSafeInteger(row.mode))
      || (row.type === 'file' && row.mtimeMs !== null && typeof row.mtimeMs !== 'number')
      || (row.type === 'local' && !row.key.startsWith('localStorage:')) ||(['file', 'dir', 'gone'].includes(row.type) && row.key.charAt(0) !== '/')) {
      wrong(row.key, 'row shape'); continue
    }
    if (!BYTE_TYPES.has(row.type)) {
      if (row.bytes !== 0 || row.sha256 !== null || !Array.isArray(row.pieces) || row.pieces.length !== 0) wrong(row.key, 'row shape')
      continue
    }
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !HEX64.test(row.sha256 ?? '') || !Array.isArray(row.pieces)
      || row.pieces.length !== Math.ceil(row.bytes / piece) || !row.pieces.every(hash => HEX64.test(hash))) {
      wrong(row.key, 'row shape'); continue
    }
    bytes += row.bytes
    if (row.type === 'file') {
      if (kit.isThread(row.key)) {
        threads += 1
        if (typeof row.mtimeMs === 'number' && (newest === null || row.mtimeMs > newest)) newest = row.mtimeMs
        if (mainThread === null || row.bytes > mainThread.bytes) mainThread = { key: row.key, bytes: row.bytes, mtimeMs: row.mtimeMs }
      } else if (row.key.startsWith('/dsh/home/')) homeFiles += 1
    }
    if (row.bytes === 0) { if (row.sha256 !== EMPTY_SHA256) wrong(row.key, 'whole SHA-256'); continue }
    queue.push(row)
  }
  // The kit writes rows in key order, so in index order each row's offset is the one before it plus that row's bytes
  // (rows without bytes included): every offset is fixed, none is free to change.
  let next = MAGIC.length
  for (const row of index.rows) {
    if (!isRecord(row)) continue
    if (row.offset !== next) wrong(typeof row.key === 'string' ? row.key : '(no key)', 'offset not where the kit puts it')
    next = (Number.isSafeInteger(row.offset) ? row.offset : next) + (BYTE_TYPES.has(row.type) && Number.isSafeInteger(row.bytes) && row.bytes > 0 ? row.bytes : 0)
  }
  queue.sort((a, b) => a.offset - b.offset)
  // The rows must sit one after another, from just after the magic to the index.
  let expected = MAGIC.length
  for (const row of queue) {
    if (row.offset !== expected) { wrong(row.key, 'offset'); expected = row.offset }
    expected += row.bytes
  }
  if (expected !== dataEnd) wrong('(pack)', 'row bytes do not end where the index starts')

  // Stream the row bytes once, feeding each row's whole hash and its current piece hash.
  let position = MAGIC.length, at = 0, row = queue[0], whole = null, part = null, partBytes = 0, pieceNumber = 0, rowBad = false, fed = false
  const startRow = () => { whole = createHash('sha256'); part = createHash('sha256'); partBytes = 0; pieceNumber = 0; rowBad = false; fed = false }
  if (row) startRow()
  const closePiece = () => {
    if (part.digest('hex') !== row.pieces[pieceNumber] && !rowBad) { wrong(row.key, 'piece ' + pieceNumber + ' SHA-256'); rowBad = true }
    pieceNumber += 1; part = createHash('sha256'); partBytes = 0
  }
  if (dataEnd > MAGIC.length) {
    for await (const chunk of createReadStream(path, { start: MAGIC.length, end: dataEnd - 1, highWaterMark: 1 << 20 })) {
      let offset = 0
      while (offset < chunk.length && row) {
        // A row that overlaps the one before it (already named under 'offset') is not read.
        if (!fed && position > row.offset) { at += 1; row = queue[at]; if (row) startRow(); continue }
        if (position < row.offset) { const skip = Math.min(chunk.length - offset, row.offset - position); offset += skip; position += skip; continue }
        const take = Math.min(chunk.length - offset, row.offset + row.bytes - position, piece - partBytes)
        const slice = chunk.subarray(offset, offset + take)
        whole.update(slice); part.update(slice); fed = true
        offset += take; position += take; partBytes += take
        const rowDone = position === row.offset + row.bytes
        if (partBytes === piece || rowDone) closePiece()
        if (rowDone) {
          if (whole.digest('hex') !== row.sha256 && !rowBad) wrong(row.key, 'whole SHA-256')
          at += 1; row = queue[at]
          if (row) startRow()
        }
      }
    }
  }
  for (; at < queue.length; at++) wrong(queue[at].key, 'missing bytes')

  const totals = index.totals
  const sameMain = (totals.mainThread ?? null) === null ? mainThread === null
    : mainThread !== null && isRecord(totals.mainThread) && totals.mainThread.key === mainThread.key && totals.mainThread.bytes === mainThread.bytes
  if (totals.threads !== threads || totals.homeFiles !== homeFiles || totals.bytes !== bytes || (totals.newestThreadMtimeMs ?? null) !== newest || !sameMain) {
    wrong('(totals)', 'the index totals differ from its rows')
  }

  // The pin: the id the kit showed (in the file name and on screen) must be what this index hashes to.
  const id = kit.indexId(index)
  const named = /aukora-rescue-([0-9a-f]{32})/.exec(basename(path))?.[1] ?? null
  const expectId = options.expectId ?? null
  if (named === null && expectId === null) wrong('(id)', 'not pinned: the file name holds no id and no --expect-id was given')
  if (named !== null && named !== id) wrong('(id)', 'the index hashes to a different id than the file name')
  if (expectId !== null && expectId !== id) wrong('(id)', 'the index hashes to a different id than --expect-id')
  if (counts.file === 0 && !options.allowEmpty) wrong('(pack)', 'empty: it holds no file at all (pass --allow-empty to accept that)')

  // What the run could not copy.
  const c = index.completeness, u = index.unlisted
  const older = c !== undefined && u === undefined && completenessShape(c, OLDER_COMPLETENESS_FIELDS)
  let notComplete = null
  if (c === undefined) notComplete = 'not recorded (this pack was made by a kit older than this check, which did not record what it could not copy)'
  else if (older) {
    if (!c.settings && counts.local > chatLogs) wrong('(completeness)', 'saved settings in a pack that says they were not copied')
    notComplete = 'made by an older kit, which did not read every copied row again or record a listing that failed'
  } else if (!completenessShape(c) || !countedShape(u)) { wrong('(completeness)', 'record shape'); notComplete = 'the record is unreadable' }
  else {
    if (!c.settings && counts.local > chatLogs) wrong('(completeness)', 'saved settings in a pack that says they were not copied')
    const parts = []
    const shapesOf = record => record.shapes.map(entry => entry.shape + ': ' + entry.count).join('; ')
    if (c.unreadable.count + c.missing + c.newRows + c.changed + c.vanished > 0) {
      const shapes = shapesOf(c.unreadable)
      parts.push(`unreadable ${c.unreadable.count}${shapes ? ' (' + shapes + ')' : ''}, missing ${c.missing}, new rows ${c.newRows}, changed ${c.changed}, vanished ${c.vanished}`)
    }
    if (u.count > 0) parts.push(`listings that failed ${u.count} (${shapesOf(u)})`)
    if (c.rechecked !== index.rows.length) parts.push(`checked again ${c.rechecked} of ${index.rows.length} rows`)
    if (parts.length > 0) notComplete = parts.join('; ')
  }
  const complete = notComplete === null
  const code = mismatches.length > 0 ? 1 : complete ? 0 : 3
  const lines = [
    `id: ${id} (file name: ${named === null ? 'holds none' : named === id ? 'equal' : 'DIFFERENT'}; --expect-id: ${expectId === null ? 'not given' : expectId === id ? 'equal' : 'DIFFERENT'})`,
    `rows: ${index.rows.length} (files ${counts.file}, folders ${counts.dir}, gone ${counts.gone}, records ${counts.meta}, saved settings ${counts.local})`,
    `threads: ${threads}, home files: ${homeFiles}, bytes: ${bytes}`,
    mainThread ? `main thread: ${kit.threadLabel(mainThread.key)}: ${mainThread.bytes} bytes, saved ${typeof mainThread.mtimeMs === 'number' ? hhmm(mainThread.mtimeMs) : 'never'}` : 'main thread: none',
    `newest save of any thread: ${newest === null ? 'none' : hhmm(newest) + ' (' + new Date(newest).toString() + ')'}`,
    ...(threads === 0 ? ['*** NO THREAD: this pack holds no thread at all ***'] : []),
    `Auma Live chat logs: ${chatLogs}`,
    `saved settings: ${c === undefined ? 'not recorded' : isRecord(c) && c.settings === true ? 'copied' : 'not copied (only Auma Live chat logs)'}`,
    ...index.skipped.map(entry => `left in that browser: ${isRecord(entry) ? entry.shape : '?'}: ${isRecord(entry) ? entry.count : '?'}`),
    ...(isRecord(c) && count(c.grew) && c.grew > 0 ? [`grew: ${c.grew} rows got longer after they were read (her thread simply got longer; this pack holds what was read)`] : []),
    complete ? 'completeness: complete' : `NOT COMPLETE: ${notComplete}`,
    `mismatches: ${mismatches.length}`,
    ...mismatches.map(entry => `mismatch: ${entry.key} (${entry.reason})`),
  ]
  return { ok: mismatches.length === 0, complete, code, id, lines, mismatches, index, text, dataEnd }
}

/**
 * A row key as path parts under files/, or null when any part could escape or is not a plain name. A backslash is
 * refused on every computer (Windows reads it as a folder mark, so `..\\..\\x` would climb out there, and a pack must
 * mean the same files wherever it is opened); a colon is refused on Windows only (a drive or a hidden stream there, an
 * ordinary letter elsewhere).
 * @param {unknown} key
 * @param {string} [platform] - the computer's platform (tests pass 'win32').
 */
export function partsOf(key, platform = process.platform) {
  if (typeof key !== 'string' || key.charAt(0) !== '/') return null
  const parts = key.slice(1).split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.includes('\0') || part.includes('\\')
    || (platform === 'win32' && part.includes(':')))) return null
  return parts
}
/** True when `target` lies strictly inside `base` once both are resolved (the last guard before any write). */
export function inside(base, target) {
  const root = resolve(base) + sep
  return resolve(target).startsWith(root)
}

/** Stream one row's bytes from the pack into a new file (never an existing one), hashing as it goes. */
async function writeRow(pack, row, target) {
  const handle = await open(target, 'wx', 0o600)
  const hash = createHash('sha256')
  try {
    if (row.bytes > 0) {
      for await (const chunk of createReadStream(pack, { start: row.offset, end: row.offset + row.bytes - 1, highWaterMark: 1 << 20 })) {
        hash.update(chunk)
        let done = 0
        while (done < chunk.length) done += (await handle.write(chunk, done, chunk.length - done)).bytesWritten
      }
    }
  } finally { await handle.close() }
  return hash.digest('hex')
}
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(chunk)
  return hash.digest('hex')
}
async function readSmall(pack, row) {
  const handle = await open(pack, 'r')
  try {
    const bytes = Buffer.alloc(row.bytes)
    if (row.bytes > 0) await handle.read(bytes, 0, row.bytes, row.offset)
    return bytes.toString('utf8')
  } finally { await handle.close() }
}

/**
 * Turn a VERIFIED pack into files: `<folder>/files/<row path>` for every file row (thread journals included), folders for
 * folder rows, `<folder>/INDEX.json` (the index exactly as in the pack), `<folder>/RECORDS.json` (her bookkeeping rows as
 * [key, value] pairs) and `<folder>/SETTINGS.json` ([name, value] pairs) only when the pack copied saved settings (any
 * saved-setting row: Auma Live's chat logs, which every pack of this kit carries, or all of them). Refuses
 * a folder that exists and is not empty. Never overwrites: a file and a folder (or two names a case-blind disk sees as
 * one) that clash are counted, and the later one is not written. File modes are kept but never more than owner read and
 * write; folders are owner-only (0700); file save times are kept. Every file written is hashed again from disk. Gone rows
 * are counted, not written. It does NOT put anything back into a browser.
 * @returns {Promise<{ok: boolean, lines: string[], counts: object}>}
 */
export async function extractRescuePack(pack, verified, folder) {
  let existing = null
  try { existing = await lstat(folder) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new NotAPack('the extract folder exists and is not a folder')
    if ((await readdir(folder)).length > 0) throw new NotAPack('the extract folder exists and is not empty')
  } else await mkdir(folder, { mode: 0o700 })
  const base = join(folder, 'files')
  await mkdir(base, { mode: 0o700 })
  const counts = { files: 0, folders: 0, gone: 0, records: 0, settings: 0, clashes: 0, refusedPaths: 0, rehashFailed: 0, badRecords: 0 }
  const made = new Set()
  /** Make each folder level under files/; false when a level clashes with a file (or another spelling of a folder). */
  const folderAt = async parts => {
    let path = base
    for (const part of parts) {
      path = join(path, part)
      if (!inside(base, path)) return false
      if (made.has(path)) continue
      try { await mkdir(path, { mode: 0o700 }); made.add(path) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const there = await lstat(path)
        if (!there.isDirectory() || there.isSymbolicLink()) return false
        // It exists but this run never made it under this spelling: the disk folds two names into one.
        counts.clashes += 1
        made.add(path)
      }
    }
    return true
  }
  const records = [], settings = []
  for (const row of verified.index.rows) {
    if (row.type === 'meta') {
      try { records.push([row.key, JSON.parse(await readSmall(pack, row))]); counts.records += 1 } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        counts.badRecords += 1
      }
      continue
    }
    if (row.type === 'local') { settings.push([row.key.slice('localStorage:'.length), await readSmall(pack, row)]); continue }
    if (row.type === 'gone') { counts.gone += 1; continue }
    const parts = partsOf(row.key)
    if (!parts) { counts.refusedPaths += 1; continue }
    if (row.type === 'dir') { if (await folderAt(parts)) counts.folders += 1; else counts.clashes += 1; continue }
    if (!(await folderAt(parts.slice(0, -1)))) { counts.clashes += 1; continue }
    const target = join(base, ...parts)
    if (!inside(base, target)) { counts.refusedPaths += 1; continue }
    let written
    try { written = await writeRow(pack, row, target) } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'EISDIR') { counts.clashes += 1; continue }
      throw error
    }
    if (written !== row.sha256 || (await hashFile(target)) !== row.sha256) { counts.rehashFailed += 1; continue }
    if (typeof row.mtimeMs === 'number') await utimes(target, row.mtimeMs / 1000, row.mtimeMs / 1000)
    await chmod(target, (Number.isSafeInteger(row.mode) ? row.mode : 0o600) & 0o600)
    counts.files += 1
  }
  const writeJson = async (name, text) => {
    const handle = await open(join(folder, name), 'wx', 0o600)
    try { await handle.writeFile(text) } finally { await handle.close() }
  }
  await writeJson('INDEX.json', verified.text)
  await writeJson('RECORDS.json', JSON.stringify(records) + '\n')
  if ((isRecord(verified.index.completeness) && verified.index.completeness.settings === true) || settings.length > 0) {
    await writeJson('SETTINGS.json', JSON.stringify(settings) + '\n')
    counts.settings = settings.length
  }
  const ok = counts.clashes === 0 && counts.refusedPaths === 0 && counts.rehashFailed === 0 && counts.badRecords === 0
  const lines = [
    `extracted: files ${counts.files}, folders ${counts.folders}, records ${counts.records}, saved settings ${counts.settings}; gone rows not written ${counts.gone}`,
    `not written: clashes ${counts.clashes}, refused paths ${counts.refusedPaths}, failed the re-hash from disk ${counts.rehashFailed}, records that are not JSON ${counts.badRecords}`,
    ok ? 'extract: every file was written and hashed again from disk' : 'EXTRACT NOT COMPLETE: see the counts above',
  ]
  return { ok, lines, counts }
}

const USAGE = 'usage: node server/rescue-verify.mjs <pack> [--expect-id <id>] [--allow-empty] [--extract <new empty folder> [--extract-incomplete]]\n'

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let path = null, expectId = null, allowEmpty = false, extract = null, extractIncomplete = false
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]
    if (arg === '--expect-id') expectId = args[++at] ?? ''
    else if (arg === '--allow-empty') allowEmpty = true
    else if (arg === '--extract') extract = args[++at] ?? ''
    else if (arg === '--extract-incomplete') extractIncomplete = true
    else if (!arg.startsWith('--') && path === null) path = arg
    else { process.stderr.write(USAGE); process.exit(2) }
  }
  if (!path || (expectId !== null && !ID.test(expectId)) || extract === '' || (extractIncomplete && extract === null)) { process.stderr.write(USAGE); process.exit(2) }
  // An error's own message can carry a path (her private folder among them): only this tool's own words are printed.
  const said = error => (error instanceof NotAPack ? error.message : typeof error?.code === 'string' ? error.code : 'an error')
  let result
  try { result = await verifyRescuePack(path, { expectId, allowEmpty }) } catch (error) {
    process.stderr.write(`not a readable rescue pack: ${error instanceof NotAPack ? error.message : 'it could not be read'}\n`)
    process.exit(2)
  }
  process.stdout.write(result.lines.join('\n') + '\n')
  if (extract === null) process.exit(result.code)
  if (result.code === 1 || (result.code === 3 && !extractIncomplete)) {
    process.stdout.write(result.code === 1 ? 'extract refused: the pack did not verify\n' : 'extract refused: the pack is NOT COMPLETE (add --extract-incomplete to extract it anyway)\n')
    process.exit(result.code)
  }
  try {
    const done = await extractRescuePack(path, result, extract)
    process.stdout.write(done.lines.join('\n') + '\n')
    process.exit(done.ok ? result.code : 1)
  } catch (error) {
    process.stderr.write(`extract stopped: ${said(error)}\n`)
    process.exit(1)
  }
}
