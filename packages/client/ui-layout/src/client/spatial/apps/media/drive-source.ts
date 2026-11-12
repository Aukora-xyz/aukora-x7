// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE DRIVE'S READ CHANNEL. Everything here reads; nothing writes, locks or moves a file.
 *
 * - LIST: her own read-only estate tool, through the page bridge (`work/bridge.ts`, the same call path the Work surface
 *   uses). It walks a folder recursively, gives sizes and change times, and is not confined to one thread's folder. Its
 *   answer travels twice in the reply body and the bridge refuses an oversize body, so an oversize page is asked again at
 *   half the page size (200, 100, 50, 25), then refused. Ten pages at most, then the listing says more files exist.
 * - PRIVATE: her private folder is never in that listing. Its direct children come from the stock `remote.workspaceFiles`
 *   `list`, through a thread whose folder is her home (a listing is confined to the thread's folder).
 * - STAT AND BYTES: `remote.workspaceFiles` `stat` and `readBytes`, always with a window of at most 2 MiB, through the
 *   thread the shell shows. Size comes from `stat` first, so a cap refuses before a single byte is read.
 * Every call carries the caller's AbortSignal and gives up after 15 s ("she may be busy").
 *
 * @module apps/media/drive-source
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkBridge } from '../../work/bridge.ts'
import { CALL_TIMEOUT_MS, WINDOW } from './drive-model.ts'
import { DRIVE_HOME, driveCanonical, driveInPlaces, driveKeptOut, drivePrivate } from './drive-rule.ts'

/** The one tool the drive calls. */
const ESTATE_TOOL = 'x6_browser_estate'
/** Smallest estate page tried before an oversize answer is refused. */
const SMALLEST_PAGE = 25
/** Most estate pages read for one listing. */
const MAX_PAGES = 10
/** Her home folder, as a thread's folder names it. */
const HOME_CWD = '/dsh/home/auma'

/** Why a drive call gave nothing. */
export type DriveFailure =
  | 'unavailable' | 'not-running' | 'no-thread' | 'no-home-thread' | 'busy' | 'missing-tool' | 'not-found' | 'changed' | 'too-large' | 'refused'
/** A drive call's answer. */
export type DriveResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: DriveFailure }

/** One file or folder the drive may show. */
export interface DriveEntry {
  readonly path: string
  readonly name: string
  readonly type: 'file' | 'directory'
  readonly size: number | null
  readonly modifiedMs: number | null
}

/** What the drive reads through. */
export interface DriveSource {
  tree(root: string, signal: AbortSignal): Promise<
    DriveResult<{ entries: readonly DriveEntry[]; truncated: boolean; privatePresent: boolean }>
  >
  children(dir: string, signal: AbortSignal): Promise<DriveResult<{ entries: readonly DriveEntry[]; truncated: boolean }>>
  stat(path: string, signal: AbortSignal): Promise<DriveResult<{ size: number; version: string; absolutePath: string | null }>>
  read(path: string, window: { offset: number; length: number }, signal: AbortSignal): Promise<
    DriveResult<{ data: Uint8Array; version: string; eof: boolean }>
  >
}

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** The three read methods of the stock `remote.workspaceFiles` service the drive uses (structural, as `work/index.ts`). */
export interface DriveFiles {
  stat(sessionId: SessionId, path: string, signal: AbortSignal): Promise<
    RemoteResult<{ absolutePath: string; version: string; bytes?: number }>
  >
  readBytes(sessionId: SessionId, path: string, options: { range?: { offset?: number; length?: number } }, signal: AbortSignal): Promise<
    RemoteResult<{ data: Uint8Array; version: string; eof: boolean }>
  >
  list(sessionId: SessionId, path: string, signal: AbortSignal): Promise<
    RemoteResult<{ entries: readonly { name: string; type: 'file' | 'directory' | 'other'; size?: number }[]; truncated: boolean }>
  >
}

/**
 * Where Media finds the files service: Media is registered outside the service's scope, so the scope sets and clears
 * this door (the same shape as the Work reader's door).
 */
export interface DriveFilesDoor {
  readonly current: () => DriveFiles | null
  readonly set: (files: DriveFiles | null) => void
  readonly subscribe: (listener: () => void) => () => void
}

/** @returns an empty door. */
export function createDriveFilesDoor(): DriveFilesDoor {
  let files: DriveFiles | null = null
  const listeners = new Set<() => void>()
  return {
    current: () => files,
    set: (next) => {
      files = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** Injected into Media by its registration. */
export interface MediaSurfaceInjected {
  readonly driveFiles: DriveFilesDoor
}

const fail = (reason: DriveFailure): { readonly ok: false; readonly reason: DriveFailure } => ({ ok: false, reason })
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const codeOf = (error: unknown): string => (isRecord(error) && typeof error.code === 'string' ? error.code : '')
const NOT_FOUND = new Set(['workspace-file/not-found', 'gateway/lookup-not-found'])

type Deadline<T> = { readonly done: true; readonly value: T } | { readonly done: false; readonly reason: 'busy' | 'refused' }

/**
 * Run one call under the caller's signal and the 15 s deadline. A call that never settles still ends here.
 * @returns the call's value, or why it ended without one.
 */
async function deadline<T>(signal: AbortSignal, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<Deadline<T>> {
  if (signal.aborted) return { done: false, reason: 'refused' }
  const controller = new AbortController()
  const late = { timedOut: false }
  const callerGone = (): boolean => signal.aborted
  const stop = (): void => { controller.abort() }
  signal.addEventListener('abort', stop)
  const timer = setTimeout(() => { late.timedOut = true; controller.abort() }, timeoutMs)
  const aborted = new Promise<'aborted'>((resolve) => { controller.signal.addEventListener('abort', () => { resolve('aborted') }) })
  try {
    const value = await Promise.race([run(controller.signal), aborted])
    if (late.timedOut) return { done: false, reason: 'busy' }
    if (value === 'aborted' || callerGone()) return { done: false, reason: 'refused' }
    return { done: true, value }
  } catch {
    return { done: false, reason: late.timedOut ? 'busy' : 'refused' }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

const bridgeFailure = (kind: string): DriveFailure =>
  kind === 'control-unavailable' || kind === 'transport' ? 'not-running' : kind === 'missing' ? 'missing-tool' : 'refused'

/** One estate page's VFS section, or null when the answer is not one. */
function vfsOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.ok === false || !isRecord(value.vfs)) return null
  const vfs = value.vfs
  return vfs.ok === false || !Array.isArray(vfs.entries) ? null : vfs
}

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** One estate row the drive may show, or null. */
function estateEntry(row: unknown, root: string): DriveEntry | null {
  if (!isRecord(row) || typeof row.path !== 'string') return null
  const path = row.path
  if (row.redacted !== undefined && row.redacted !== null && row.redacted !== false) return null
  if (!path.startsWith(root + '/') || !driveCanonical(path) || driveKeptOut(path) || drivePrivate(path)) return null
  const type = row.type === 'dir' ? 'directory' : row.type === 'file' ? 'file' : null
  if (type === null) return null
  const size = type === 'file' && typeof row.size === 'number' && Number.isFinite(row.size) ? row.size : null
  const modifiedMs = type === 'file' && typeof row.mtimeMs === 'number' && Number.isFinite(row.mtimeMs) ? row.mtimeMs : null
  return { path, name: nameOf(path), type, size, modifiedMs }
}

/**
 * The thread whose folder is her home (the shown one first); preview fixtures never qualify.
 * @param sessions - the shell's session list.
 * @returns its id, or undefined when none is open.
 */
export function homeSessionOf(sessions: {
  readonly ids: readonly SessionId[]
  readonly byId: Readonly<Record<string, {
    readonly id: SessionId
    readonly cwd?: string
    readonly retainedBy: { readonly mainView?: number }
  }>>
}): SessionId | undefined {
  const home = (id: SessionId): boolean => !String(id).startsWith('preview-') && sessions.byId[id]?.cwd === HOME_CWD
  const shown = Object.values(sessions.byId).find(s => (s.retainedBy.mainView ?? 0) > 0 && home(s.id))?.id
  return shown ?? sessions.ids.find(home)
}

/**
 * @param deps - the bridge's tool call (or null), the files service (or null), and the threads to read through.
 * @returns the drive's source; it never throws.
 */
export function createDriveSource(deps: {
  readonly callTool: WorkBridge['callTool'] | null
  readonly files: DriveFiles | null
  readonly sessionId: () => SessionId | undefined
  readonly homeSessionId: () => SessionId | undefined
  readonly timeoutMs?: number
}): DriveSource {
  const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS
  const { callTool, files } = deps
  return {
    tree: async (root, signal) => {
      if (callTool === null) return fail('unavailable')
      const entries: DriveEntry[] = []
      let privatePresent = false
      let truncated = false
      let cursor = 0
      let limit = 200
      let pages = 0
      for (;;) {
        const args = { sections: ['vfs'], root, cursor, limit, perFileHashBytes: 0 }
        const call = await deadline(signal, timeoutMs, s => callTool(ESTATE_TOOL, args, s))
        if (!call.done) return fail(call.reason)
        const body = call.value
        if (body.kind === 'bounded') {
          if (limit <= SMALLEST_PAGE) return fail('refused')
          limit /= 2
          continue
        }
        if (body.kind !== 'ok') return fail(bridgeFailure(body.kind))
        const vfs = vfsOf((body as { value?: unknown }).value)
        if (vfs === null) return fail('refused')
        for (const row of vfs.entries as unknown[]) {
          const entry = estateEntry(row, root)
          if (entry !== null) entries.push(entry)
        }
        pages += 1
        if (isRecord(vfs.private) && vfs.private.present === true) privatePresent = true
        if (isRecord(vfs.totals) && vfs.totals.walkTruncated === true) truncated = true
        const next = isRecord(vfs.page) ? vfs.page.nextCursor : null
        if (typeof next !== 'number' || next <= cursor) break
        if (pages >= MAX_PAGES) {
          truncated = true
          break
        }
        cursor = next
      }
      return { ok: true, value: { entries, truncated, privatePresent } }
    },

    children: async (dir, signal) => {
      if (files === null) return fail('unavailable')
      const home = deps.homeSessionId()
      if (home === undefined) return fail('no-home-thread')
      const call = await deadline(signal, timeoutMs, s => files.list(home, dir, s))
      if (!call.done) return fail(call.reason)
      const listed = call.value
      if (!listed.ok) {
        const code = codeOf(listed.error)
        return fail(code === 'workspace-file/outside-workspace' ? 'no-home-thread' : NOT_FOUND.has(code) ? 'not-found' : 'refused')
      }
      const entries: DriveEntry[] = []
      for (const child of listed.value.entries) {
        if (child.type === 'other' || child.name === '' || child.name.includes('/')) continue
        const path = `${dir}/${child.name}`
        if (!driveCanonical(path) || driveKeptOut(path)) continue
        const size = child.type === 'file' && typeof child.size === 'number' ? child.size : null
        entries.push({ path, name: child.name, type: child.type, size, modifiedMs: null })
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      return { ok: true, value: { entries, truncated: listed.value.truncated } }
    },

    stat: async (path, signal) => {
      if (files === null) return fail('unavailable')
      const session = deps.sessionId()
      if (session === undefined) return fail('no-thread')
      const call = await deadline(signal, timeoutMs, s => files.stat(session, path, s))
      if (!call.done) return fail(call.reason)
      const stat = call.value
      if (!stat.ok) return fail(NOT_FOUND.has(codeOf(stat.error)) ? 'not-found' : 'refused')
      if (typeof stat.value.bytes !== 'number' || typeof stat.value.version !== 'string') return fail('refused')
      return { ok: true, value: {
        size: stat.value.bytes, version: stat.value.version,
        absolutePath: typeof stat.value.absolutePath === 'string' ? stat.value.absolutePath : null,
      } }
    },

    read: async (path, window, signal) => {
      if (files === null) return fail('unavailable')
      const session = deps.sessionId()
      if (session === undefined) return fail('no-thread')
      const range = { offset: Math.max(0, window.offset), length: Math.max(0, Math.min(window.length, WINDOW)) }
      const call = await deadline(signal, timeoutMs, s => files.readBytes(session, path, { range }, s))
      if (!call.done) return fail(call.reason)
      const read = call.value
      if (!read.ok) return fail(NOT_FOUND.has(codeOf(read.error)) ? 'not-found' : 'refused')
      return { ok: true, value: { data: read.value.data, version: read.value.version, eof: read.value.eof } }
    },
  }
}

/**
 * Read one whole file: `stat` first (a cap or a re-pointed path refuses before any byte is read), then sequential
 * windows of at most 2 MiB, one call at a time; a window from another version of the file stops the read.
 * @param source - the drive source.
 * @param path - the file, already checked by the drive rule.
 * @param cap - the largest size this read accepts.
 * @param signal - aborts the read.
 * @returns the exact bytes, or why not.
 */
export async function readAll(source: DriveSource, path: string, cap: number, signal: AbortSignal): Promise<DriveResult<Uint8Array>> {
  const stat = await source.stat(path, signal)
  if (!stat.ok) return stat
  const { size, version, absolutePath } = stat.value
  if (absolutePath !== null && absolutePath !== path) {
    const allowed = driveCanonical(absolutePath) && absolutePath.startsWith(DRIVE_HOME) && driveInPlaces(absolutePath)
      && !driveKeptOut(absolutePath)
      && (!drivePrivate(absolutePath) || drivePrivate(path))
    if (!allowed) return fail('refused')
  }
  if (size > cap) return fail('too-large')
  const bytes = new Uint8Array(size)
  let offset = 0
  while (offset < size) {
    if (signal.aborted) return fail('refused')
    const window = await source.read(path, { offset, length: Math.min(WINDOW, size - offset) }, signal)
    if (!window.ok) return window
    if (window.value.version !== version) return fail('changed')
    const data = window.value.data
    if (offset + data.byteLength > size) return fail('changed')
    if (data.byteLength === 0) return fail(window.value.eof ? 'changed' : 'refused')
    bytes.set(data, offset)
    offset += data.byteLength
  }
  return { ok: true, value: bytes }
}
