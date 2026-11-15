/**
 * What a successful `x6_repo` write, edit, commit or apply_patch on her own branch says
 * back to her. The edge answers with `changes` (per file: path, old and new blob sha and size, lines added and removed,
 * a bounded hunk) and, for a staged write or edit, the whole new file in `content` (this tab keeps it as the draft).
 * The whole file is cut here, after the draft has been kept: it no longer fills her context on every edit. An edge
 * that does not send `changes` yet keeps the whole file in the answer, as before.
 */

/** `hunk` (default): the facts and the bounded hunks; `file`: the answer exactly as before; `none`: the facts only. */
export const REPO_ECHO_MODES = Object.freeze(['hunk', 'file', 'none'] as const)
export type RepoEchoMode = (typeof REPO_ECHO_MODES)[number]

/** The tab's own hunk of a draft edit: 3 context lines, at most 4 KiB (the edge's REPO_ECHO_LIMITS). */
export const REPO_DRAFT_HUNK_LIMITS = Object.freeze({ contextLines: 3, fileHunkBytes: 4 * 1024 })

/** Her previous draft of the file this staged write or edit replaced (the tab held it before the call). */
export interface RepoEchoDraft { path: string; previous: string }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const encoder = new TextEncoder()
const bytesOf = (text: string): number => encoder.encode(text).byteLength
// The one shape a diff marker can complete in front of a line (the edge screen's private-key header).
const MARKED_SECRET = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/i

/** The edge's single prefix/suffix hunk (cloud-brokers.mjs lineDiff), from her previous draft to the new text. */
export function draftHunk(left: string, right: string, path: string, contextLines = REPO_DRAFT_HUNK_LIMITS.contextLines): string {
  if (left === right) return ''
  const lines = (text: string): string[] => text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const a = lines(left), b = lines(right)
  let prefix = 0, suffix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const start = Math.max(0, prefix - contextLines), trailing = Math.min(suffix, contextLines)
  const countA = a.length - suffix + trailing - start, countB = b.length - suffix + trailing - start
  const emit = (marker: string, line: string): string => marker + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')
  let diff = `--- a/${path}\n+++ b/${path}\n@@ -${countA ? start + 1 : start},${countA} +${countB ? start + 1 : start},${countB} @@\n`
  for (let i = start; i < prefix; i++) diff += emit(' ', a[i] ?? '')
  for (let i = prefix; i < a.length - suffix; i++) diff += emit('-', a[i] ?? '')
  for (let i = prefix; i < b.length - suffix; i++) diff += emit('+', b[i] ?? '')
  for (let i = 0; i < trailing; i++) diff += emit(' ', a[a.length - suffix + i] ?? '')
  return diff
}

/** The first `room` bytes of `text`, cut back to whole lines (nothing when not one whole line fits). */
function boundedHunk(text: string, room: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= room) return text
  let cut = Math.max(0, room)
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--
  const head = new TextDecoder().decode(bytes.subarray(0, cut)), line = head.lastIndexOf('\n')
  return line >= 0 ? head.slice(0, line + 1) : ''
}

/** The hunk view of the edit she just made on top of her draft, in place of the edge's (which is from the branch head). */
function fromDraft(change: Record<string, unknown>, draft: RepoEchoDraft, content: string): Record<string, unknown> {
  const { hunkReason: _reason, ...facts } = change
  const diff = draftHunk(draft.previous, content, draft.path)
  if (MARKED_SECRET.test(diff)) return { ...facts, hunk: null, hunkOmittedBytes: bytesOf(diff), hunkReason: 'withheld', hunkFrom: 'draft' }
  const hunk = boundedHunk(diff, REPO_DRAFT_HUNK_LIMITS.fileHunkBytes)
  return { ...facts, hunk, hunkOmittedBytes: bytesOf(diff) - bytesOf(hunk), hunkFrom: 'draft' }
}

/** One file's facts without its hunk (for `echo: "none"`). */
function factsOnly(change: unknown): unknown {
  if (!record(change)) return change
  const { hunk: _hunk, hunkOmittedBytes: _omitted, hunkReason: _reason, hunkFrom: _from, ...facts } = change
  return facts
}

/**
 * Shape one successful answer for her. A refusal or any answer that is not `ok: true` comes back unchanged. An answer
 * without `changes` (an edge that does not send them yet) keeps the whole file and says so (`echo: "file"`,
 * `echoNote: "facts_unavailable"`). With `draft`, the hunk of that file is the edit she just made on her draft.
 */
export function repoEchoAnswer(json: Record<string, unknown>, mode: RepoEchoMode = 'hunk', draft?: RepoEchoDraft): Record<string, unknown> {
  if (json.ok !== true) return json
  if (!Array.isArray(json.changes)) return mode === 'file' ? json : { ...json, echo: 'file', echoNote: 'facts_unavailable' }
  if (mode === 'file') {
    const { changes: _changes, ...asBefore } = json
    return asBefore
  }
  const { content, changes, ...rest } = json
  const shaped: Record<string, unknown> = { ...rest }
  // Named only where the whole file was left out, so she knows `echo: "file"` brings it back.
  if (content !== undefined) shaped.echo = mode
  const drafted = draft && typeof content === 'string'
    ? changes.map(change => record(change) && change.path === draft.path ? fromDraft(change, draft, content) : change as unknown)
    : changes as unknown[]
  shaped.changes = mode === 'none' ? drafted.map(factsOnly) : drafted
  return shaped
}
