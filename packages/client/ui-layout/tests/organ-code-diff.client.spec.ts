/**
 * Lane B3: the organ code diff the Staged Governance Pearl card shows (portal/organ-code-diff.ts). Pure: no page, no edge.
 * Its line counts are checked against a brute-force longest common subsequence, and every size cap is hit on purpose.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODE_DIFF_MAX_CELLS, CODE_DIFF_MAX_LINE_CHARS, CODE_DIFF_MAX_ROWS, CODE_DIFF_MAX_SIDE_BYTES, CODE_DIFF_MAX_SIDE_LINES,
  codeDiffRows, codeDiffSummary, hunkHeader, organCodeDiff, utf8Length, type CodeHunk, type OrganCodeDiff,
} from '../src/client/spatial/portal/organ-code-diff.ts'

afterEach(() => { vi.restoreAllMocks() })

/** A one-line organ, exactly as the edge tests write them (r29-edge-e2e.client.spec.tsx `codeOf`). */
const codeOf = (organ: string, version: number) => `export default { organ: ${JSON.stringify(organ)}, version: ${String(version)} }\n`
const linesOf = (count: number, label = 'line') => Array.from({ length: count }, (_, index) => `${label} ${String(index + 1)}`)
const text = (lines: readonly string[]) => lines.map(line => `${line}\n`).join('')
const compared = (diff: OrganCodeDiff) => {
  if (diff.kind === 'too-large') throw new Error('expected a compared diff')
  return diff
}
const headers = (hunks: readonly CodeHunk[]) => hunks.map(hunkHeader)

/** The longest common subsequence by brute force: every subsequence of `a`, longest first, tried against `b`. */
function bruteLcs(a: readonly string[], b: readonly string[]): number {
  let best = 0
  for (let mask = 0; mask < 1 << a.length; mask += 1) {
    const picked = a.filter((_, index) => (mask & (1 << index)) !== 0)
    if (picked.length <= best) continue
    let at = 0
    for (const line of b) if (at < picked.length && line === picked[at]) at += 1
    if (at === picked.length) best = picked.length
  }
  return best
}
/** The longest common subsequence by the textbook table (an independent check for inputs too big for brute force). */
function tableLcs(a: readonly string[], b: readonly string[]): number {
  let row = new Array<number>(b.length + 1).fill(0)
  for (const line of a) {
    const next = [0]
    b.forEach((other, j) => { next.push(line === other ? (row[j] ?? 0) + 1 : Math.max(row[j + 1] ?? 0, next[j] ?? 0)) })
    row = next
  }
  return row[b.length] ?? 0
}
/** A seeded generator, so a failing case can be run again. */
const seeded = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
/**
 * Whether the hunks are the change: every numbered line is that line of its side, and the lines outside the hunks plus the
 * hunks' context lines, in order, are one common subsequence of both sides whose length is what the counts say.
 */
function hunksAgree(before: readonly string[], after: readonly string[], diff: Exclude<OrganCodeDiff, { kind: 'too-large' }>): boolean {
  const removedNo = new Set<number>()
  const addedNo = new Set<number>()
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.oldNo !== null && before[line.oldNo - 1] !== line.text) return false
      if (line.newNo !== null && after[line.newNo - 1] !== line.text) return false
      if (line.kind === 'del' && line.oldNo !== null) removedNo.add(line.oldNo)
      if (line.kind === 'add' && line.newNo !== null) addedNo.add(line.newNo)
    }
  }
  const keptOld = before.filter((_, index) => !removedNo.has(index + 1))
  const keptNew = after.filter((_, index) => !addedNo.has(index + 1))
  return removedNo.size === diff.removed && addedNo.size === diff.added && keptOld.join('\n') === keptNew.join('\n')
}

describe('organCodeDiff: the change, line by line', () => {
  it('the same text is no change: +0 / −0, no hunks', () => {
    const diff = compared(organCodeDiff(codeOf('seed-receipts', 162), codeOf('seed-receipts', 162)))
    expect(diff).toEqual({ kind: 'exact', added: 0, removed: 0, hunks: [], eolChanged: false })
    expect(codeDiffSummary(diff)).toBe('+0 / −0 lines')
  })

  it('Pearl 162 to 63 of a one-line organ: one hunk "@@ -1,1 +1,1 @@", the removed line before the added one', () => {
    const diff = organCodeDiff(codeOf('seed-receipts', 162), codeOf('seed-receipts', 63))
    expect(diff).toEqual({ kind: 'exact', added: 1, removed: 1, eolChanged: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [
      { kind: 'del', text: 'export default { organ: "seed-receipts", version: 162 }', oldNo: 1, newNo: null },
      { kind: 'add', text: 'export default { organ: "seed-receipts", version: 63 }', oldNo: null, newNo: 1 },
    ] }] })
    expect(headers(compared(diff).hunks)).toEqual(['@@ -1,1 +1,1 @@'])
    // THE MINUS IS U+2212, as the repo proposal card writes it.
    expect(codeDiffSummary(diff)).toBe('+1 / −1 lines')
  })

  it('two lines inserted after line 50 of 100: +2 / −0, one hunk with three context lines either side', () => {
    const before = linesOf(100)
    const after = [...before.slice(0, 50), 'new A', 'new B', ...before.slice(50)]
    const diff = compared(organCodeDiff(text(before), text(after)))
    expect([diff.kind, diff.added, diff.removed]).toEqual(['exact', 2, 0])
    expect(headers(diff.hunks)).toEqual(['@@ -48,6 +48,8 @@'])
    expect(diff.hunks[0]?.lines.map(line => `${line.kind}:${line.text}`)).toEqual([
      'ctx:line 48', 'ctx:line 49', 'ctx:line 50', 'add:new A', 'add:new B', 'ctx:line 51', 'ctx:line 52', 'ctx:line 53'])
    expect(diff.hunks[0]?.lines.map(line => [line.oldNo, line.newNo])).toEqual([
      [48, 48], [49, 49], [50, 50], [null, 51], [null, 52], [51, 53], [52, 54], [53, 55]])
    expect(codeDiffSummary(diff)).toBe('+2 / −0 lines')
  })

  it('changes six unchanged lines apart or nearer are one hunk; seven or more apart, two (said "in 2 places")', () => {
    const before = linesOf(40)
    const change = (at: readonly number[]) => before.map((line, index) => (at.includes(index + 1) ? `${line} changed` : line))
    const near = compared(organCodeDiff(text(before), text(change([10, 17]))))
    expect(headers(near.hunks)).toEqual(['@@ -7,14 +7,14 @@'])
    expect(codeDiffSummary(near)).toBe('+2 / −2 lines')
    const apart = compared(organCodeDiff(text(before), text(change([10, 18]))))
    expect(headers(apart.hunks)).toEqual(['@@ -7,7 +7,7 @@', '@@ -15,7 +15,7 @@'])
    expect(codeDiffSummary(apart)).toBe('+2 / −2 lines in 2 places')
    const far = compared(organCodeDiff(text(before), text(change([5, 25]))))
    expect(far.hunks).toHaveLength(2)
  })

  it('a new organ is all added, a removed one all removed (a start of 0 with 0 lines, as diff -u writes it)', () => {
    const code = 'export default {\n  organ: "seed-continuity",\n}\n'
    const added = compared(organCodeDiff('', code))
    expect([added.added, added.removed, added.eolChanged]).toEqual([3, 0, false])
    expect(headers(added.hunks)).toEqual(['@@ -0,0 +1,3 @@'])
    expect(added.hunks[0]?.lines.every(line => line.kind === 'add')).toBe(true)
    const removed = compared(organCodeDiff(code, ''))
    expect([removed.added, removed.removed]).toEqual([0, 3])
    expect(headers(removed.hunks)).toEqual(['@@ -1,3 +0,0 @@'])
  })

  it('bytes are compared exactly: a newline missing at the end changes the last line, and CRLF is not LF', () => {
    const eol = compared(organCodeDiff('a\n', 'a'))
    expect([eol.added, eol.removed, eol.eolChanged]).toEqual([1, 1, true])
    const longer = compared(organCodeDiff('a\nb', 'a\nb\n'))
    expect([longer.added, longer.removed, longer.eolChanged]).toEqual([1, 1, true])
    expect(longer.hunks[0]?.lines.map(line => line.kind)).toEqual(['ctx', 'del', 'add'])
    // An empty side has no last line to differ.
    expect(compared(organCodeDiff('', 'a')).eolChanged).toBe(false)
    const crlf = compared(organCodeDiff('a\r\nb\r\n', 'a\nb\n'))
    expect([crlf.added, crlf.removed, crlf.eolChanged]).toEqual([2, 2, false])
    // Drawn, a carriage return is made visible, so the two do not look the same.
    expect(codeDiffRows(crlf).rows.filter(row => row.kind === 'del').map(row => row.text)).toEqual(['a␍', 'b␍'])
  })

  it('in a changed run every removed line comes before the added ones', () => {
    const diff = compared(organCodeDiff('keep\nold 1\nold 2\nkeep 2\n', 'keep\nnew 1\nnew 2\nkeep 2\n'))
    expect(diff.hunks[0]?.lines.map(line => line.kind)).toEqual(['ctx', 'del', 'del', 'add', 'add', 'ctx'])
  })

  it('PROPERTY: the counts are n − LCS and m − LCS against a brute-force LCS, and the hunks are the change', () => {
    const random = seeded(20_261_111)
    for (let round = 0; round < 400; round += 1) {
      const side = () => Array.from({ length: Math.floor(random() * 13) }, () => 'abc'.charAt(Math.floor(random() * 3)))
      const before = side()
      const after = side()
      const eolBefore = random() < 0.8
      const eolAfter = random() < 0.8
      const diff = compared(organCodeDiff(before.join('\n') + (eolBefore && before.length > 0 ? '\n' : ''),
        after.join('\n') + (eolAfter && after.length > 0 ? '\n' : '')))
      expect(diff.kind).toBe('exact')
      // A last line whose newline differs is a different line: compare with that mark on it.
      const marked = (lines: readonly string[], eol: boolean) => lines.map((line, index) => (!eol && index === lines.length - 1 ? `${line}$` : line))
      const a = marked(before, eolBefore)
      const b = marked(after, eolAfter)
      const lcs = bruteLcs(a, b)
      expect([diff.removed, diff.added], JSON.stringify({ before, after, eolBefore, eolAfter })).toEqual([a.length - lcs, b.length - lcs])
      expect(hunksAgree(before, after, diff), JSON.stringify({ before, after })).toBe(true)
    }
  })

  it('PROPERTY: a few hundred lines with scattered edits match the textbook LCS table', () => {
    const random = seeded(162)
    for (let round = 0; round < 6; round += 1) {
      const before = Array.from({ length: 300 }, () => `x ${String(Math.floor(random() * 40))}`)
      const after = before.flatMap(line => (random() < 0.15 ? [] : random() < 0.1 ? [line, `y ${String(Math.floor(random() * 40))}`] : [line]))
      const diff = compared(organCodeDiff(text(before), text(after)))
      const lcs = tableLcs(before, after)
      expect([diff.kind, diff.removed, diff.added]).toEqual(['exact', before.length - lcs, after.length - lcs])
      expect(hunksAgree(before, after, diff)).toBe(true)
    }
  })
})

describe('organCodeDiff: every bound is a size cap', () => {
  it('a side over 512 KiB is too large, and nothing is split', () => {
    const big = 'x'.repeat(CODE_DIFF_MAX_SIDE_BYTES + 1)
    const split = vi.spyOn(String.prototype, 'split')
    const diff = organCodeDiff('a\n', big)
    const calls = split.mock.calls.length
    split.mockRestore()
    expect(calls).toBe(0)
    expect(diff).toEqual({ kind: 'too-large', oldBytes: 2, newBytes: CODE_DIFF_MAX_SIDE_BYTES + 1, oldLines: null, newLines: null })
    expect(codeDiffSummary(diff)).toBe('too large to compare here (2 B → 512.0 KiB; this page compares up to 512.0 KiB a side)')
    expect(codeDiffRows(diff)).toEqual({ rows: [], hiddenRows: 0 })
  })

  it('the byte cap counts UTF-8 bytes, as HEAD hashes them, not characters', () => {
    const wide = 'é'.repeat(300_000)
    expect(wide.length).toBeLessThan(CODE_DIFF_MAX_SIDE_BYTES)
    expect(organCodeDiff('', wide)).toMatchObject({ kind: 'too-large', newBytes: 600_000 })
    for (const sample of ['plain', 'é ü ß', '漢字', '😀 and 🧬', '\ud800 lone', 'lone \udc00', 'end \ud83d']) {
      expect(utf8Length(sample), sample).toBe(new TextEncoder().encode(sample).byteLength)
    }
  })

  it('a side over 20,000 lines is too large, with both line counts said', () => {
    const many = text(linesOf(CODE_DIFF_MAX_SIDE_LINES + 1, 'l'))
    expect(utf8Length(many)).toBeLessThan(CODE_DIFF_MAX_SIDE_BYTES)
    const diff = organCodeDiff('a\n', many)
    expect(diff).toMatchObject({ kind: 'too-large', oldLines: 1, newLines: CODE_DIFF_MAX_SIDE_LINES + 1 })
    expect(codeDiffSummary(diff)).toBe('too large to compare here (1 → 20001 lines; this page compares up to 20,000 a side)')
  })

  it('a changed middle over 4,000,000 cells is one block: "at most" both counts, one hunk', () => {
    const before = linesOf(2_100, 'old')
    const after = linesOf(2_100, 'new')
    expect(2_100 * 2_100).toBeGreaterThan(CODE_DIFF_MAX_CELLS)
    const diff = organCodeDiff(`head\n${text(before)}tail\n`, `head\n${text(after)}tail\n`)
    expect(diff).toMatchObject({ kind: 'block', added: 2_100, removed: 2_100, eolChanged: false })
    const block = compared(diff)
    expect(headers(block.hunks)).toEqual(['@@ -1,2102 +1,2102 @@'])
    expect(block.hunks[0]?.lines.map(line => line.kind).join('')).toBe(`ctx${'del'.repeat(2_100)}${'add'.repeat(2_100)}ctx`)
    expect(codeDiffSummary(diff)).toBe('at most +2100 / −2100 lines (too many changed lines to compare one by one here)')
  })

  it('20,000 lines with one line changed is exact: the common lines either side are set aside first', () => {
    const before = linesOf(CODE_DIFF_MAX_SIDE_LINES)
    const after = before.map((line, index) => (index === 12_345 ? 'changed' : line))
    const diff = compared(organCodeDiff(text(before), text(after)))
    expect([diff.kind, diff.added, diff.removed]).toEqual(['exact', 1, 1])
    expect(headers(diff.hunks)).toEqual(['@@ -12343,7 +12343,7 @@'])
  })

  it('rows past 500 are counted, not drawn; a line past 1,000 characters is clipped with "…"', () => {
    const block = organCodeDiff(text(linesOf(2_100, 'old')), text(linesOf(2_100, 'new')))
    const drawn = codeDiffRows(block)
    expect(drawn.rows).toHaveLength(CODE_DIFF_MAX_ROWS)
    expect(drawn.hiddenRows).toBe(1 + 4_200 - CODE_DIFF_MAX_ROWS)
    expect(drawn.rows[0]).toEqual({ kind: 'hunk', text: '@@ -1,2100 +1,2100 @@' })
    expect(codeDiffRows(block, 10)).toMatchObject({ hiddenRows: 4_191 })
    const long = compared(organCodeDiff('short\n', `${'y'.repeat(5_000)}\n`))
    const added = codeDiffRows(long).rows.find(row => row.kind === 'add')
    expect(added?.text).toBe(`${'y'.repeat(CODE_DIFF_MAX_LINE_CHARS)}…`)
    // Never cut inside a surrogate pair.
    const emoji = compared(organCodeDiff('', `${'z'.repeat(CODE_DIFF_MAX_LINE_CHARS - 1)}😀 and more\n`))
    expect(codeDiffRows(emoji).rows.find(row => row.kind === 'add')?.text).toBe(`${'z'.repeat(CODE_DIFF_MAX_LINE_CHARS - 1)}…`)
    // The counts stay whole however few rows are drawn.
    expect(codeDiffSummary(block)).toContain('+2100 / −2100')
  })
})
