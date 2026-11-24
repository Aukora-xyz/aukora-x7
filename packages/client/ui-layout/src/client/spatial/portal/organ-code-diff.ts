// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE ORGAN CODE DIFF (Lane B3): the line diff the Staged Governance Pearl card shows between the code an organ runs now
 * and the code the staged Pearl would run. It is display only: it decides nothing, and the approval never binds it.
 *
 *   organCodeDiff    the whole change: exact line counts from a longest common subsequence of the changed middle; past
 *                    the cell cap, the middle as one block with upper bounds ("at most"); past a side cap, "too large"
 *   codeDiffSummary  the counts in words, e.g. "+1 / −1 lines"
 *   codeDiffRows     the rows a card draws: hunk headers and lines, capped, each line clipped
 *
 * EVERY BOUND IS A SIZE CAP, never a timer, so the cost is fixed by the inputs: 512 KiB and 20,000 lines per side, and
 * 4,000,000 cells for the changed middle once the common first and last lines are set aside. BYTES ARE COMPARED EXACTLY
 * (HEAD hashes exact bytes): a carriage return stays in its line, and a newline missing at the end makes the last line a
 * changed line. No dependency: the largest organ in one measured mirror is 46,553 B and 713 lines.
 * @module portal/organ-code-diff
 */

/** The most UTF-8 bytes a side may have to be compared here. */
export const CODE_DIFF_MAX_SIDE_BYTES = 512 * 1024
/** The most lines a side may have to be compared here. */
export const CODE_DIFF_MAX_SIDE_LINES = 20_000
/** The most cells (changed lines before × changed lines after) compared line by line; past it the middle is one block. */
export const CODE_DIFF_MAX_CELLS = 4_000_000
/** Unchanged lines shown on each side of a change (as `diff -u`). */
export const CODE_DIFF_CONTEXT = 3
/** The most rows a card draws (hunk headers and lines). */
export const CODE_DIFF_MAX_ROWS = 500
/** The most characters drawn of one line; a longer one is clipped with "…". */
export const CODE_DIFF_MAX_LINE_CHARS = 1_000

/** One line of a hunk, numbered on the side(s) it is on (1-based). */
export interface CodeLine {
  readonly kind: 'ctx' | 'del' | 'add'
  readonly text: string
  /** Its number in the code it runs now (null for an added line). */
  readonly oldNo: number | null
  /** Its number in the new code (null for a removed line). */
  readonly newNo: number | null
}

/** One hunk, as `diff -u` numbers it: a start of 0 with 0 lines means "before the first line". */
export interface CodeHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly CodeLine[]
}

/** A change that was compared: its line counts, its hunks, and whether the newline at the end of the file differs. */
export interface ComparedCode {
  readonly added: number
  readonly removed: number
  readonly hunks: readonly CodeHunk[]
  readonly eolChanged: boolean
}

/**
 * The change.
 *   exact      `added` and `removed` are exact: lines in the new code / the old code that are in no longest common
 *              subsequence of the two (the same numbers however its ties break)
 *   block      the changed middle was over the cell cap: one hunk holds all of it, removed then added, and the counts are
 *              upper bounds (the exact ones can only be smaller)
 *   too-large  a side was over the byte cap (lines not counted, null) or the line cap: nothing was compared
 */
export type OrganCodeDiff =
  | ({ readonly kind: 'exact' } & ComparedCode)
  | ({ readonly kind: 'block' } & ComparedCode)
  | {
    readonly kind: 'too-large'
    readonly oldBytes: number
    readonly newBytes: number
    readonly oldLines: number | null
    readonly newLines: number | null
  }

/**
 * A text's length in UTF-8 bytes, as `TextEncoder` encodes it (a lone surrogate is 3 bytes, U+FFFD), without a copy.
 * @param text - the text.
 * @returns its byte length.
 */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

/** Its lines, counted without splitting: every newline ends one, and text after the last newline is one more. */
const lineCount = (text: string): number => {
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1
  return text === '' || text.endsWith('\n') ? count : count + 1
}

/** A side's lines (without their newlines), and whether its last line ends in one. */
interface Side { readonly lines: readonly string[]; readonly eol: boolean }
const sideOf = (text: string): Side => {
  if (text === '') return { lines: [], eol: true }
  const lines = text.split('\n')
  const eol = text.endsWith('\n')
  if (eol) lines.pop()
  return { lines, eol }
}

const CTX = 0
const DEL = 1
const ADD = 2

/** Each line as a number, equal numbers for equal lines across both sides. */
const interner = () => {
  const ids = new Map<string, number>()
  return (side: Side): Int32Array => {
    const out = new Int32Array(side.lines.length)
    side.lines.forEach((line, index) => {
      // A last line without its newline is never the same line as one with it. The key cannot collide: no line holds '\n'.
      const key = !side.eol && index === side.lines.length - 1 ? `\n${line}` : line
      let id = ids.get(key)
      if (id === undefined) {
        id = ids.size
        ids.set(key, id)
      }
      out[index] = id
    })
    return out
  }
}

/** A middle with nothing in common to look for: every old line removed, then every new line added. */
const blockOps = (removed: number, added: number): Uint8Array => new Uint8Array(removed + added).fill(DEL, 0, removed).fill(ADD, removed)

/**
 * The longest common subsequence of the middle (`rows` old lines from `start`, `cols` new lines from `start`), as the
 * walk through it: lengths in two rolling rows, directions in one byte per cell. A tie removes before it adds, so in each
 * changed run the removed lines come first, as in `diff -u`.
 */
function lcsOps(before: Int32Array, after: Int32Array, start: number, rows: number, cols: number): Uint8Array {
  const direction = new Uint8Array(rows * cols)
  let below = new Uint32Array(cols + 1)
  let here = new Uint32Array(cols + 1)
  for (let i = rows - 1; i >= 0; i -= 1) {
    here[cols] = 0
    const line = before[start + i]
    for (let j = cols - 1; j >= 0; j -= 1) {
      const cell = i * cols + j
      const down = below[j] ?? 0
      const right = here[j + 1] ?? 0
      if (line === after[start + j]) {
        here[j] = (below[j + 1] ?? 0) + 1
        direction[cell] = CTX
      } else if (down >= right) {
        here[j] = down
        direction[cell] = DEL
      } else {
        here[j] = right
        direction[cell] = ADD
      }
    }
    ;[below, here] = [here, below]
  }
  const ops = new Uint8Array(rows + cols)
  let length = 0
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    const step = direction[i * cols + j] ?? CTX
    ops[length] = step
    length += 1
    if (step !== ADD) i += 1
    if (step !== DEL) j += 1
  }
  // What is left of either side once the other is used up.
  ops.fill(DEL, length, length + rows - i)
  length += rows - i
  ops.fill(ADD, length, length + cols - j)
  length += cols - j
  return ops.subarray(0, length)
}

/** The hunks of a walk: each change with CONTEXT lines either side, changes CONTEXT×2 lines apart or nearer in one hunk. */
function hunksOf(ops: Uint8Array, before: readonly string[], after: readonly string[]): CodeHunk[] {
  // How many old and new lines come before each step.
  const oldAt = new Int32Array(ops.length + 1)
  const newAt = new Int32Array(ops.length + 1)
  ops.forEach((op, k) => {
    oldAt[k + 1] = (oldAt[k] ?? 0) + (op === ADD ? 0 : 1)
    newAt[k + 1] = (newAt[k] ?? 0) + (op === DEL ? 0 : 1)
  })
  const hunks: CodeHunk[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k] === CTX) {
      k += 1
      continue
    }
    const start = Math.max(0, k - CODE_DIFF_CONTEXT)
    let end = k
    let j = k
    while (j < ops.length) {
      if (ops[j] !== CTX) {
        j += 1
        end = j
        continue
      }
      let next = j
      while (next < ops.length && ops[next] === CTX) next += 1
      if (next === ops.length || next - j > 2 * CODE_DIFF_CONTEXT) break
      j = next
    }
    const stop = Math.min(ops.length, end + CODE_DIFF_CONTEXT)
    const lines: CodeLine[] = []
    for (let q = start; q < stop; q += 1) {
      const oldIndex = oldAt[q] ?? 0
      const newIndex = newAt[q] ?? 0
      const op = ops[q]
      if (op === DEL) lines.push({ kind: 'del', text: before[oldIndex] ?? '', oldNo: oldIndex + 1, newNo: null })
      else if (op === ADD) lines.push({ kind: 'add', text: after[newIndex] ?? '', oldNo: null, newNo: newIndex + 1 })
      else lines.push({ kind: 'ctx', text: before[oldIndex] ?? '', oldNo: oldIndex + 1, newNo: newIndex + 1 })
    }
    const oldFirst = oldAt[start] ?? 0
    const newFirst = newAt[start] ?? 0
    const oldLines = (oldAt[stop] ?? 0) - oldFirst
    const newLines = (newAt[stop] ?? 0) - newFirst
    hunks.push({ oldStart: oldLines === 0 ? oldFirst : oldFirst + 1, oldLines,
      newStart: newLines === 0 ? newFirst : newFirst + 1, newLines, lines })
    k = stop
  }
  return hunks
}

/**
 * The line diff of two versions of an organ's code.
 * @param before - the code it runs now ('' for a new organ).
 * @param after - the new code ('' for a removed organ).
 * @returns the change: exact, one block (upper bounds), or too large to compare here.
 */
export function organCodeDiff(before: string, after: string): OrganCodeDiff {
  // THE SIZE GATE FIRST: nothing over a cap is split.
  const oldBytes = utf8Length(before)
  const newBytes = utf8Length(after)
  if (oldBytes > CODE_DIFF_MAX_SIDE_BYTES || newBytes > CODE_DIFF_MAX_SIDE_BYTES) {
    return { kind: 'too-large', oldBytes, newBytes, oldLines: null, newLines: null }
  }
  const oldCount = lineCount(before)
  const newCount = lineCount(after)
  if (oldCount > CODE_DIFF_MAX_SIDE_LINES || newCount > CODE_DIFF_MAX_SIDE_LINES) {
    return { kind: 'too-large', oldBytes, newBytes, oldLines: oldCount, newLines: newCount }
  }
  const old = sideOf(before)
  const next = sideOf(after)
  const intern = interner()
  const a = intern(old)
  const b = intern(next)
  // The common first and last lines are in every longest common subsequence, so only the middle is searched.
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1
  const rows = a.length - prefix - suffix
  const cols = b.length - prefix - suffix
  const block = rows > 0 && cols > 0 && rows * cols > CODE_DIFF_MAX_CELLS
  const middle = block || rows === 0 || cols === 0 ? blockOps(rows, cols) : lcsOps(a, b, prefix, rows, cols)
  const ops = new Uint8Array(prefix + middle.length + suffix)
  ops.set(middle, prefix)
  let added = 0
  let removed = 0
  for (const op of middle) {
    if (op === ADD) added += 1
    else if (op === DEL) removed += 1
  }
  const eolChanged = old.lines.length > 0 && next.lines.length > 0 && old.eol !== next.eol
  return { kind: block ? 'block' : 'exact', added, removed, hunks: hunksOf(ops, old.lines, next.lines), eolChanged }
}

/** A size in words: bytes under 1 KiB, else KiB to one decimal. */
const sizeWords = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`)

/**
 * The change in words, for the row's one line. The minus is U+2212, as the repo proposal card writes it.
 * @param diff - the change.
 * @returns e.g. "+1 / −1 lines", "+12 / −3 lines in 2 places", "at most +2100 / −2100 lines (…)", "too large to compare here (…)".
 */
export function codeDiffSummary(diff: OrganCodeDiff): string {
  switch (diff.kind) {
    case 'exact': return `+${diff.added} / −${diff.removed} lines${diff.hunks.length >= 2 ? ` in ${diff.hunks.length} places` : ''}`
    case 'block': return `at most +${diff.added} / −${diff.removed} lines (too many changed lines to compare one by one here)`
    case 'too-large': return diff.oldLines === null || diff.newLines === null
      ? `too large to compare here (${sizeWords(diff.oldBytes)} → ${sizeWords(diff.newBytes)}; this page compares up to `
        + `${sizeWords(CODE_DIFF_MAX_SIDE_BYTES)} a side)`
      : `too large to compare here (${diff.oldLines} → ${diff.newLines} lines; this page compares up to `
        + `${CODE_DIFF_MAX_SIDE_LINES.toLocaleString('en-US')} a side)`
  }
}

/**
 * A hunk's header, always with both counts.
 * @param hunk - the hunk.
 * @returns e.g. "@@ -1,1 +1,1 @@".
 */
export const hunkHeader = (hunk: CodeHunk): string => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`

/** One row a card draws. */
export type CodeDiffRowView =
  | { readonly kind: 'hunk'; readonly text: string }
  | CodeLine

/** A line as drawn: a carriage return made visible (␍), and clipped at the cap with "…" (never inside a surrogate pair). */
const drawn = (text: string): string => {
  const visible = text.includes('\r') ? text.replaceAll('\r', '␍') : text
  if (visible.length <= CODE_DIFF_MAX_LINE_CHARS) return visible
  const cut = visible.charCodeAt(CODE_DIFF_MAX_LINE_CHARS - 1) >= 0xd800 && visible.charCodeAt(CODE_DIFF_MAX_LINE_CHARS - 1) <= 0xdbff
    ? CODE_DIFF_MAX_LINE_CHARS - 1 : CODE_DIFF_MAX_LINE_CHARS
  return `${visible.slice(0, cut)}…`
}

/**
 * The rows a card draws, in order: each hunk's header, then its lines. Rows past the cap are counted, not drawn.
 * @param diff - the change.
 * @param maxRows - the most rows drawn.
 * @returns the rows, and how many were left out.
 */
export function codeDiffRows(diff: OrganCodeDiff, maxRows: number = CODE_DIFF_MAX_ROWS)
  : { readonly rows: readonly CodeDiffRowView[]; readonly hiddenRows: number } {
  if (diff.kind === 'too-large') return { rows: [], hiddenRows: 0 }
  const rows: CodeDiffRowView[] = []
  let total = 0
  for (const hunk of diff.hunks) {
    total += 1 + hunk.lines.length
    if (rows.length < maxRows) rows.push({ kind: 'hunk', text: hunkHeader(hunk) })
    for (const line of hunk.lines) {
      if (rows.length >= maxRows) break
      rows.push({ ...line, text: drawn(line.text) })
    }
  }
  return { rows, hiddenRows: total - rows.length }
}
