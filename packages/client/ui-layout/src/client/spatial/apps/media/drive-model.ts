// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * The drive's pure model: where her files live, what kind each one is, which place shows it, the caps every read obeys,
 * and the words for sizes and times. No reads here.
 *
 * @module apps/media/drive-model
 */

/** One byte window: the host's `maxBytes` for a ranged read (workspace-files `index.ts`). */
export const WINDOW = 2 * 1024 * 1024
/** Largest text, Markdown or JSON file previewed. */
export const TEXT_CAP = 2 * 1024 * 1024
/** Largest image previewed. */
export const IMAGE_CAP = 16 * 1024 * 1024
/** Largest file downloaded from here. */
export const DOWNLOAD_CAP = 64 * 1024 * 1024
/** A call that takes longer than this is aborted; she may be busy. */
export const CALL_TIMEOUT_MS = 15_000
/** How much of a text file is checked for a NUL byte. */
export const NUL_SCAN_BYTES = 8 * 1024

/** Her screenshots: `latest.png` and the ring of the last 12. */
export const CAPTURES_DIR = '/dsh/home/auma/captures'
/** Where she writes documents. */
export const DOCS_DIR = '/dsh/home/auma/docs'

/** The raster image types a preview Blob may carry; nothing else is ever drawn as an image. */
export type RasterMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** What a file is, as the drive shows and previews it. */
export interface DriveKind {
  /** The pill's word. */
  readonly label: string
  /** Which place it belongs to and its pill colour. */
  readonly family: 'text' | 'image' | 'video' | 'other'
  /** How the preview pane shows it. */
  readonly preview: 'markdown' | 'text' | 'image' | 'none'
  /** For a raster image only. */
  readonly mime?: RasterMime
}

const MARKDOWN: DriveKind = { label: 'Markdown', family: 'text', preview: 'markdown' }
const TEXT: DriveKind = { label: 'Text', family: 'text', preview: 'text' }
const JSON_KIND: DriveKind = { label: 'JSON', family: 'text', preview: 'text' }
const VIDEO: DriveKind = { label: 'Video', family: 'video', preview: 'none' }
const FILE: DriveKind = { label: 'File', family: 'other', preview: 'none' }

const KINDS: Readonly<Record<string, DriveKind>> = {
  md: MARKDOWN, markdown: MARKDOWN,
  txt: TEXT, log: TEXT, csv: TEXT, tsv: TEXT, yaml: TEXT, yml: TEXT, toml: TEXT, html: TEXT, htm: TEXT, xml: TEXT, css: TEXT,
  js: TEXT, mjs: TEXT, ts: TEXT,
  json: JSON_KIND, jsonl: JSON_KIND,
  // Shown as its text, never drawn: an image of this kind can carry script.
  svg: { label: 'SVG image', family: 'text', preview: 'text' },
  png: { label: 'PNG image', family: 'image', preview: 'image', mime: 'image/png' },
  jpg: { label: 'JPEG image', family: 'image', preview: 'image', mime: 'image/jpeg' },
  jpeg: { label: 'JPEG image', family: 'image', preview: 'image', mime: 'image/jpeg' },
  webp: { label: 'WebP image', family: 'image', preview: 'image', mime: 'image/webp' },
  gif: { label: 'GIF image', family: 'image', preview: 'image', mime: 'image/gif' },
  mp4: VIDEO, webm: VIDEO, mov: VIDEO, m4v: VIDEO, ogv: VIDEO, mkv: VIDEO,
  pdf: { label: 'PDF', family: 'other', preview: 'none' },
}

/**
 * @param name - a file name or path.
 * @returns its kind, by extension in any case; a name without one is a plain file.
 */
export function driveKind(name: string): DriveKind {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return FILE
  return KINDS[base.slice(dot + 1).toLowerCase()] ?? FILE
}

/** The drive's places for files (Private is its own row). */
export type DriveSection = 'captures' | 'documents' | 'images' | 'video'

/**
 * @param path - an absolute file path.
 * @returns the place that lists it, or null when no place does.
 */
export function driveSection(path: string): DriveSection | null {
  const kind = driveKind(path)
  if (path.startsWith(CAPTURES_DIR + '/')) {
    if (kind.family === 'image') return 'captures'
    return kind.family === 'video' ? 'video' : null
  }
  if (path.startsWith(DOCS_DIR + '/')) {
    if (kind.family === 'video') return 'video'
    return kind.family === 'image' ? 'images' : 'documents'
  }
  return null
}

/** Newest first, ties by name, unknown times last. */
type Dated = { readonly name: string; readonly modifiedMs: number | null }
export function newestFirst(a: Dated, b: Dated): number {
  if (a.modifiedMs !== b.modifiedMs) {
    if (a.modifiedMs === null) return 1
    if (b.modifiedMs === null) return -1
    return b.modifiedMs - a.modifiedMs
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * @param bytes - a size.
 * @returns "512 B", "4.2 KB", "48 KB", "5.0 MB": base 1024, one decimal under 10.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'TB'}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (value: number): string => String(value).padStart(2, '0')

/**
 * @param ms - when the file changed.
 * @param now - the clock.
 * @returns "14:05" today, "12 Nov 14:05" this year, "12 Nov 2025" before.
 */
export function formatTime(ms: number, now: number): string {
  const at = new Date(ms)
  const today = new Date(now)
  const clock = `${two(at.getHours())}:${two(at.getMinutes())}`
  if (at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()) return clock
  const day = `${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ''}`
  return at.getFullYear() === today.getFullYear() ? `${day} ${clock}` : `${day} ${String(at.getFullYear())}`
}

/** U+2060 WORD JOINER: invisible, zero width, never a line break. */
const WORD_JOINER = '⁠'

/**
 * Make a Markdown source unable to show any image. Every image in the renderer's grammar (inline, reference, and the
 * local-path recovery) needs the two characters `![` side by side in the source, so putting a word joiner between them
 * turns each one into its plain `!` followed by an ordinary link or text: nothing is fetched when the file is opened,
 * not from another site and not from this one with his cookies. Only characters are added, never removed, so no new
 * `![` can form. Inside code the joiner is invisible.
 * @param source - the Markdown as written.
 * @returns the same Markdown, with no image in it.
 */
export function inertImages(source: string): string {
  return source.replaceAll('![', `!${WORD_JOINER}[`)
}
