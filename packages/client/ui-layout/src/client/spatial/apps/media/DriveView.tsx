// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * MEDIA AND DOCUMENTS: HER DRIVE. The Drive view inside Media: her screenshots, her documents, her images and videos,
 * and her Private folder, newest first, with a preview and a Download for each file. Read only: nothing here writes,
 * moves or deletes a file (the read channel is `drive-source.ts`; the drive rule is `drive-rule.ts`).
 *
 * WHAT IS SHOWN. Markdown through the chat's own renderer, with every image made inert first (`inertImages`: a document
 * never makes this page fetch anything, from another site or from this one); text, JSON, SVG and HTML as plain text (never rendered); PNG,
 * JPEG, WebP and GIF from a `blob:` URL typed with exactly that raster type. Everything else says it has no preview.
 * A download is always an `application/octet-stream` Blob saved under the file's own name.
 *
 * NO NAVIGATION. Nothing here moves this tab: a link to this site (any scheme or port) or to an odd scheme does nothing,
 * another site opens in a new tab without an opener, and a local link selects that file in the drive.
 *
 * WHEN IT READS. The listing once when the view opens and on Refresh; a file when it is selected; Private only after the
 * owner taps Open folder, and a Private file only after Show preview. No timer, no poll.
 *
 * @module apps/media/DriveView
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { ActionControl, FieldTable, Mono, Panel, RecordList, RecordRow, SectionHeader, StatusPill } from '../../primitives/index.ts'
import type { Tone } from '../../primitives/index.ts'
import {
  CAPTURES_DIR, DOCS_DIR, DOWNLOAD_CAP, driveKind, driveSection, formatSize, formatTime, IMAGE_CAP, inertImages, newestFirst,
  NUL_SCAN_BYTES, TEXT_CAP,
  type DriveKind, type DriveSection,
} from './drive-model.ts'
import { DRIVE_HOME, driveCanonical, driveInPlaces, driveKeptOut, drivePrivate, parseDriveTarget, PRIVATE_DIR } from './drive-rule.ts'
import { readAll, type DriveEntry, type DriveFailure, type DriveSource } from './drive-source.ts'
import { fill, t, type MediaKey } from './locales.ts'
import { MediaIcon } from './MediaIcon.tsx'
import css from './Drive.module.css'

/** One place in the drive's left column. */
type Place = DriveSection | 'private' | `folder:${string}`

type Listing =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly DriveEntry[]; readonly truncated: boolean; readonly privatePresent: boolean }
  | { readonly status: 'failed'; readonly reason: DriveFailure }

type FolderListing =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly DriveEntry[] }
  | { readonly status: 'failed'; readonly reason: DriveFailure }

/** The selected file; a new object on every selection, so the same file selected again is read again. */
interface Selection { readonly path: string }

type Body =
  | { readonly kind: 'loading' }
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'private' }
  | { readonly kind: 'message'; readonly text: string; readonly download: boolean }
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'image'; readonly url: string }

const SECTIONS: readonly DriveSection[] = ['captures', 'documents', 'images', 'video']
const SECTION_ROOT: Readonly<Record<DriveSection, string>> = {
  captures: CAPTURES_DIR, documents: DOCS_DIR, images: DOCS_DIR, video: DRIVE_HOME.slice(0, -1),
}
const SECTION_EMPTY: Readonly<Record<DriveSection, MediaKey>> = {
  captures: 'drive.emptyCaptures', documents: 'drive.emptyDocuments', images: 'drive.emptyImages', video: 'drive.emptyVideo',
}
const FAMILY_TONE: Readonly<Record<DriveKind['family'], Tone>> = { text: 'blue', image: 'violet', video: 'gold', other: 'muted' }
const FAILURE_LINE: Readonly<Record<Exclude<DriveFailure, 'not-found' | 'too-large'>, MediaKey>> = {
  'unavailable': 'drive.unavailable', 'not-running': 'drive.notRunning', 'no-thread': 'drive.noThread', 'no-home-thread': 'drive.noHomeThread',
  'busy': 'drive.busy', 'missing-tool': 'drive.missingTool', 'changed': 'drive.changed', 'refused': 'drive.refused',
}
const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' } },
  footnotes: 'Footnotes',
}
const decoder = new TextDecoder('utf-8', { fatal: false })

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/**
 * The words for a failed read.
 * @param reason - why.
 * @param path - the file, for "There is no file at".
 * @param size - its size, for "Too large".
 * @returns one plain line.
 */
function failureLine(reason: DriveFailure, path: string, size: number | null): string {
  if (reason === 'not-found') return fill('drive.missing', { path })
  if (reason === 'too-large') return size === null ? t('drive.tooLargeDownload') : fill('drive.tooLargePreview', { size: formatSize(size) })
  return t(FAILURE_LINE[reason])
}

/**
 * The drive's refusal of a path before anything is read, in the fixed order: not a plain path, outside her home, not in
 * one of the drive's places, kept out.
 * @returns the copy key, or null when the drive may open it.
 */
function refusalOf(path: string): MediaKey | null {
  if (!driveCanonical(path)) return 'drive.notPlain'
  if (!path.startsWith(DRIVE_HOME)) return 'drive.outside'
  if (!driveInPlaces(path)) return 'drive.notInDrive'
  if (driveKeptOut(path)) return 'drive.keptOut'
  return null
}

/** The place a path belongs to, or null. */
function placeOf(path: string): Place | null {
  if (refusalOf(path) !== null) return null
  return drivePrivate(path) ? 'private' : driveSection(path)
}

const bareHost = (host: string): string => host.toLowerCase().replace(/\.$/u, '')
/** Whether a URL names THIS site's host, whatever its scheme or port. */
const sameHost = (url: URL): boolean => bareHost(url.hostname) === bareHost(window.location.hostname)

/** Whether a click on this link may go ahead: another site over http(s), or mail. Everything else does nothing. */
function linkAllowed(href: string): boolean {
  let url: URL
  try { url = new URL(href, document.baseURI) } catch { return false }
  if (url.protocol === 'mailto:') return true
  return (url.protocol === 'http:' || url.protocol === 'https:') && !sameHost(url)
}

/**
 * Hand a blob to the browser's own download (an anchor with `download`; copied from the Sovereignty surface's `saveBlob`).
 * The page opens no window of its own. The URL lives a minute, so a save sheet left open can still read it.
 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
}

/** How many characters of a name's stem stay beside its extension when a narrow row cuts the name. */
const NAME_TAIL = 6

/**
 * A file's name cut in the MIDDLE when its row is narrow (a phone): the start ellipsised, the end of its stem and its
 * extension always shown, so `20261112T140500Z-aaaa….png` still says what kind of file it is. The text is the whole name.
 */
export function FileName({ name }: { readonly name: string }) {
  const dot = name.lastIndexOf('.')
  const stemEnd = dot > 0 ? dot : name.length
  const cut = Math.max(0, stemEnd - NAME_TAIL)
  return (
    <span className={css.name} data-drive-name="">
      <span className={css.nameHead}>{name.slice(0, cut)}</span>
      <span className={css.nameTail}>{name.slice(cut)}</span>
    </span>
  )
}

/** Whether the person asked for less motion (then a scroll jumps instead of gliding). */
function reducedMotion(): boolean {
  const media = (globalThis as { readonly matchMedia?: unknown }).matchMedia
  if (typeof media !== 'function') return false
  try { return (media as (query: string) => { readonly matches?: unknown })('(prefers-reduced-motion: reduce)').matches === true } catch { return false }
}

/**
 * THE LANE'S OWN SCROLLER: the nearest ancestor that scrolls vertically (in the Spatial frame, the app's
 * `.ak-app`). Never the page: the walk stops below `<body>`, so nothing here ever moves the document itself.
 */
function laneScroller(node: HTMLElement): HTMLElement | null {
  for (let at = node.parentElement; at !== null && at !== document.body && at !== document.documentElement; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return at
  }
  return null
}

/**
 * Bring a node into view inside its lane's scroller only (`scrollIntoView` would move every scrolling ancestor, the page
 * too). 'start' puts its top at the top of the scroller's visible area; 'nearest' moves only when it is out of view.
 * Smooth unless the person asked for less motion.
 */
function scrollInLane(node: HTMLElement, block: 'start' | 'nearest'): void {
  const scroller = laneScroller(node)
  if (scroller === null) return
  const box = scroller.getBoundingClientRect()
  const rect = node.getBoundingClientRect()
  const top = box.top + scroller.clientTop
  const bottom = top + scroller.clientHeight
  let delta = rect.top - top
  if (block === 'nearest') {
    if (rect.top >= top && rect.bottom <= bottom) return
    if (rect.top > top) delta = Math.min(delta, rect.bottom - bottom)
  }
  const to = { top: scroller.scrollTop + delta, behavior: reducedMotion() ? 'auto' : 'smooth' } as const
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo(to)
  else scroller.scrollTop = to.top
}

/** "48 KB · 14:05 · ring": size, the change time as a `<time>`, and the folder when not at the place's root. */
function RowSummary({ entry, root, now }: { readonly entry: DriveEntry; readonly root: string; readonly now: number }) {
  const parts: ReactNode[] = []
  if (entry.size !== null) parts.push(formatSize(entry.size))
  if (entry.modifiedMs !== null) {
    parts.push(<time key="t" dateTime={new Date(entry.modifiedMs).toISOString()}>{formatTime(entry.modifiedMs, now)}</time>)
  }
  const folder = parentOf(entry.path)
  if (folder !== root && folder.startsWith(root + '/')) parts.push(folder.slice(root.length + 1))
  return <>{parts.flatMap((part, index) => (index === 0 ? [part] : [' · ', part]))}</>
}

/**
 * How a selection is shown. 'focus': the action started inside the drive (a row's Open, a link in a
 * previewed document), so the preview heading takes the focus. 'announce': it came from her chat (a file link, "Open in
 * drive" on an image), so the keyboard stays where it was and the drive's polite live region says which file opened.
 */
type Reveal = 'focus' | 'announce'

/** One ask to show the preview: `n` counts the asks, so each is carried out once. */
interface RevealAsk { readonly n: number; readonly how: Reveal; readonly path: string }

/**
 * The drive. Mounted only while Media shows Drive; unmounting aborts every read in flight.
 * @param props.target - Media's surface target (`drive:<n>:<path>`), when a chat link opened the drive.
 * @param props.targetIsNew - whether this Media has not handled `target` yet. Media keeps the last
 *   handled target, so a drive mounted again (Studio, then Drive) only restores that selection: no scroll, no focus move.
 * @param props.onTargetHandled - told each target the drive has taken.
 */
export function DriveView({ source, target, targetIsNew = true, onTargetHandled }: {
  readonly source: DriveSource
  readonly target?: string | undefined
  readonly targetIsNew?: boolean | undefined
  readonly onTargetHandled?: ((target: string) => void) | undefined
}) {
  const [refreshes, setRefreshes] = useState(0)
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [place, setPlace] = useState<Place>('captures')
  const [privateOpen, setPrivateOpen] = useState<Readonly<Record<string, FolderListing>>>({})
  const [selection, setSelection] = useState<Selection | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [size, setSize] = useState<number | null>(null)
  const [body, setBody] = useState<Body | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadNote, setDownloadNote] = useState<string | null>(null)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const driveRef = useRef<HTMLDivElement>(null)
  const previewCard = useRef<HTMLDivElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  // THE ROW THAT OPENED THE PREVIEW: Back and Escape return to it.
  const [openedFrom, setOpenedFrom] = useState<string | null>(null)
  // Each selection a person makes asks once for the preview to be shown; `shownReveal` is the last ask carried out.
  const [reveal, setReveal] = useState<RevealAsk | null>(null)
  const shownReveal = useRef(0)
  // What the polite live region says: the file a chat link opened; empty otherwise.
  const [announcement, setAnnouncement] = useState('')
  /** Flipped on every said line, so the same words twice still change the live region's text (a reader repeats only a change). */
  const announceFlip = useRef(false)
  // The surface target this drive has taken (a mount takes each target once; Media says whether it is new).
  const takenTarget = useRef<string | null>(null)
  const folderReads = useRef(new Set<AbortController>())
  const downloadRead = useRef<AbortController | null>(null)

  // THE LISTING: once on open, and on Refresh. Her two folders, one call at a time.
  useEffect(() => {
    const controller = new AbortController()
    setListing({ status: 'loading' })
    void (async () => {
      const entries: DriveEntry[] = []
      let truncated = false
      let privatePresent = false
      for (const root of [CAPTURES_DIR, DOCS_DIR]) {
        const tree = await source.tree(root, controller.signal)
        if (controller.signal.aborted) return
        if (!tree.ok) {
          setListing({ status: 'failed', reason: tree.reason })
          return
        }
        entries.push(...tree.value.entries)
        truncated ||= tree.value.truncated
        privatePresent ||= tree.value.privatePresent
      }
      setListing({ status: 'ready', entries, truncated, privatePresent })
    })()
    return () => { controller.abort() }
  }, [source, refreshes])

  // Private folder reads end with the view.
  useEffect(() => {
    const reads = folderReads.current
    return () => {
      for (const controller of reads) controller.abort()
      downloadRead.current?.abort()
    }
  }, [])

  /**
   * Select a file. `reveal` (every way a person picks a file: a row's Open, a chat link, "Open in drive" on an image, a
   * link in a previewed document) also shows the preview; Refresh re-reads the selection without moving anything.
   */
  const select = useCallback((path: string, options: { readonly fromRow?: boolean; readonly reveal?: Reveal } = {}): void => {
    downloadRead.current?.abort()
    setSelection({ path })
    setRevealed(false)
    setDownloading(false)
    setDownloadNote(null)
    setCopy('idle')
    setOpenedFrom(options.fromRow === true ? path : null)
    const how = options.reveal
    if (how !== undefined) setReveal(ask => ({ n: (ask?.n ?? 0) + 1, how, path }))
  }, [])

  // A FILE THAT BECOMES THE SELECTION IS SHOWN: the preview card's top goes to the top of the lane's own
  // scroller (the page never moves), so opening a file never looks like nothing happened. Only once the layout holding
  // the card exists: while the listing is still being read the list above the card has no height yet, so this waits for
  // it (and for the place the selection moved to) instead of scrolling to where the card will be.
  // THE KEYBOARD: the heading takes the focus only when the action started inside the drive. A chat
  // link leaves the focus where it was (she may be typing to Auma), late listing or not, and the live region names the
  // file instead.
  useEffect(() => {
    if (reveal === null || reveal.n === shownReveal.current || listing.status === 'loading') return
    const card = previewCard.current
    const heading = previewHeading.current
    if (card === null || heading === null) return
    shownReveal.current = reveal.n
    scrollInLane(card, 'start')
    if (reveal.how === 'focus') {
      setAnnouncement('')
      heading.focus({ preventScroll: true })
      return
    }
    // A path the drive refuses is never named (it may be a kept-out name): the refusal is said instead.
    const refused = refusalOf(reveal.path)
    const line = refused === null ? fill('drive.opened', { name: nameOf(reveal.path) }) : t(refused)
    // The same file (or the same refusal) twice in a row: a trailing no-break space on every other line makes the text differ.
    announceFlip.current = !announceFlip.current
    setAnnouncement(announceFlip.current ? line : `${line}\u00a0`)
  }, [reveal, listing.status, place])

  /**
   * Back to the row that opened the preview: into view in the lane, and the focus on its Open.
   * @returns whether it moved the focus (no row on screen: nothing moved, so Escape is left to Media).
   */
  const back = useCallback((): boolean => {
    const path = openedFrom
    if (path === null) return false
    const row = [...(driveRef.current?.querySelectorAll<HTMLElement>('[data-drive-open]') ?? [])]
      .find(control => control.getAttribute('data-drive-open') === path)
    if (row === undefined) return false
    scrollInLane(row, 'nearest')
    row.focus({ preventScroll: true })
    return document.activeElement === row
  }, [openedFrom])

  /**
   * A chat link or a link in a previewed document: select the file and show its place. `how` shows its preview too;
   * without it (a chat link this Media already handled, the drive mounted again) only the selection comes back.
   */
  const goTo = useCallback((path: string, how?: Reveal): void => {
    select(path, how === undefined ? {} : { reveal: how })
    const at = placeOf(path)
    if (at !== null) setPlace(at)
  }, [select])

  // A REVEAL HAPPENS ONCE: the target stays in the frame's store while Media is open, and this view is
  // mounted again on every Studio -> Drive. A target Media has handled only restores its selection.
  useEffect(() => {
    if (target === undefined || takenTarget.current === target) return
    const path = parseDriveTarget(target)
    if (path === null) return
    takenTarget.current = target
    goTo(path, targetIsNew ? 'announce' : undefined)
    onTargetHandled?.(target)
  }, [target, targetIsNew, goTo, onTargetHandled])

  // THE PREVIEW: the drive rule first, then Private, then stat (size first), then at most one capped read.
  useEffect(() => {
    if (selection === null) return
    const path = selection.path
    setSize(null)
    const refused = refusalOf(path)
    if (refused !== null) {
      setBody({ kind: 'refused', text: t(refused) })
      return
    }
    if (drivePrivate(path) && !revealed) {
      setBody({ kind: 'private' })
      return
    }
    const controller = new AbortController()
    const stopped = (): boolean => controller.signal.aborted
    let url: string | null = null
    setBody({ kind: 'loading' })
    void (async () => {
      const stat = await source.stat(path, controller.signal)
      if (stopped()) return
      if (!stat.ok) {
        setBody({ kind: 'message', text: failureLine(stat.reason, path, null), download: false })
        return
      }
      setSize(stat.value.size)
      const kind = driveKind(path)
      if (kind.preview === 'none') {
        setBody({ kind: 'message', text: t('drive.noPreview'), download: true })
        return
      }
      const cap = kind.preview === 'image' ? IMAGE_CAP : TEXT_CAP
      if (stat.value.size > cap) {
        setBody({ kind: 'message', text: fill('drive.tooLargePreview', { size: formatSize(stat.value.size) }), download: true })
        return
      }
      const bytes = await readAll(source, path, cap, controller.signal)
      if (stopped()) return
      if (!bytes.ok) {
        setBody({ kind: 'message', text: failureLine(bytes.reason, path, stat.value.size), download: bytes.reason !== 'not-found' })
        return
      }
      if (kind.preview === 'image' && kind.mime !== undefined) {
        url = URL.createObjectURL(new Blob([bytes.value as Uint8Array<ArrayBuffer>], { type: kind.mime }))
        setBody({ kind: 'image', url })
        return
      }
      if (bytes.value.subarray(0, NUL_SCAN_BYTES).includes(0)) {
        setBody({ kind: 'message', text: t('drive.notText'), download: true })
        return
      }
      const text = decoder.decode(bytes.value)
      setBody(kind.preview === 'markdown' ? { kind: 'markdown', text } : { kind: 'text', text })
    })()
    return () => {
      controller.abort()
      if (url !== null) URL.revokeObjectURL(url)
    }
  }, [source, selection, revealed])

  const openFolder = (dir: string): void => {
    if (privateOpen[dir] !== undefined && privateOpen[dir].status !== 'failed') {
      // Open again closes it, with everything under it.
      setPrivateOpen(open => Object.fromEntries(Object.entries(open).filter(([key]) => key !== dir && !key.startsWith(dir + '/'))))
      return
    }
    const controller = new AbortController()
    folderReads.current.add(controller)
    setPrivateOpen(open => ({ ...open, [dir]: { status: 'loading' } }))
    void source.children(dir, controller.signal).then((children) => {
      folderReads.current.delete(controller)
      if (controller.signal.aborted) return
      setPrivateOpen(open => ({ ...open, [dir]: children.ok ? { status: 'ready', entries: children.value.entries } : { status: 'failed', reason: children.reason } }))
    })
  }

  const download = (): void => {
    if (selection === null || downloading) return
    const path = selection.path
    const controller = new AbortController()
    downloadRead.current?.abort()
    downloadRead.current = controller
    setDownloading(true)
    setDownloadNote(null)
    void readAll(source, path, DOWNLOAD_CAP, controller.signal).then((bytes) => {
      if (controller.signal.aborted) return
      setDownloading(false)
      if (!bytes.ok) {
        setDownloadNote(bytes.reason === 'too-large' ? t('drive.tooLargeDownload') : failureLine(bytes.reason, path, null))
        return
      }
      saveBlob(new Blob([bytes.value as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), nameOf(path))
    })
  }

  const copyPath = (): void => {
    if (selection === null) return
    setCopy('idle')
    try {
      void navigator.clipboard.writeText(selection.path).then(() => { setCopy('copied') }, () => { setCopy('failed') })
    } catch {
      setCopy('failed')
    }
  }

  // Links inside a previewed document never move this tab.
  const guardLinks = (event: ReactMouseEvent<HTMLElement>): void => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (anchor !== null && !linkAllowed(anchor.getAttribute('href') ?? '')) event.preventDefault()
  }
  const openExternalLink = useCallback((href: string): void => {
    let url: URL
    try { url = new URL(href) } catch { return }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || sameHost(url)) return
    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])
  const selectedPath = selection?.path ?? null
  const openFile = useCallback((path: string): void => {
    if (selectedPath === null) return
    // A link in a previewed document is an action inside the drive: the new preview's heading takes the focus.
    if (path.startsWith('/')) {
      goTo(path, 'focus')
      return
    }
    let rest = path
    while (rest.startsWith('./')) rest = rest.slice(2)
    goTo(`${parentOf(selectedPath)}/${rest}`, 'focus')
  }, [goTo, selectedPath])

  const now = Date.now()
  const ready = listing.status === 'ready' ? listing : null
  const files = (ready?.entries ?? []).filter(entry => entry.type === 'file')
  const bySection = Object.fromEntries(SECTIONS.map(section => [
    section, files.filter(entry => driveSection(entry.path) === section).sort(newestFirst),
  ])) as Record<DriveSection, DriveEntry[]>
  /** Files listed across all places (each file is in one place at most). */
  const shownCount = SECTIONS.reduce((sum, section) => sum + bySection[section].length, 0)
  const folders = (ready?.entries ?? []).filter(entry => entry.type === 'directory' && parentOf(entry.path) === DOCS_DIR)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const entryAt = (path: string): DriveEntry | undefined => ready?.entries.find(entry => entry.path === path)

  // A count is a dash until the listing is read: never a zero that is not known.
  const placeControl = (value: Place, label: ReactNode, count: number | null, folder = false) => (
    <ActionControl key={value} role="tab" aria-selected={place === value} aria-pressed={place === value} tone="blue"
      className={folder ? css.folder : undefined} data-drive-place={value} onClick={() => { setPlace(value) }}>
      {label}{count === null ? null : ready === null
        ? <span className={css.count} data-drive-count="unknown" title={t('drive.countUnknown')}>–</span>
        : <span className={css.count} data-drive-count={count}>{count}</span>}
    </ActionControl>
  )

  const fileRow = (entry: DriveEntry, root: string) => {
    const kind = driveKind(entry.path)
    const selected = selectedPath === entry.path
    // The kind chip steps aside on a phone (Drive.module.css), so the name keeps the room.
    return (
      <RecordRow key={entry.path} tone="muted" title={<FileName name={entry.name} />} rowTitle={entry.path}
        status={<span className={css.kind} data-drive-kind=""><StatusPill tone={FAMILY_TONE[kind.family]}>{kind.label}</StatusPill></span>}
        summary={<RowSummary entry={entry} root={root} now={now} />}
        end={<ActionControl tone="blue" className={css.open} aria-pressed={selected} aria-label={`${t('drive.open')} ${entry.name}`}
          data-drive-open={entry.path} onClick={() => { select(entry.path, { fromRow: true, reveal: 'focus' }) }}>{t('drive.open')}</ActionControl>} />
    )
  }

  const folderControl = (dir: string) => (
    <ActionControl tone="gold" aria-expanded={privateOpen[dir]?.status === 'ready'} data-drive-open-folder={dir} onClick={() => { openFolder(dir) }}>
      <MediaIcon kind="folder" />{t('drive.openFolder')}
    </ActionControl>
  )

  /** Private, flattened: each opened folder's children follow it. */
  const privateRows = (dir: string): ReactNode[] => {
    const open = privateOpen[dir]
    if (open?.status !== 'ready') return []
    return open.entries.flatMap(entry => (entry.type === 'directory'
      ? [<RecordRow key={entry.path} tone="muted" title={entry.name} rowTitle={entry.path}
        summary={parentOf(entry.path) === PRIVATE_DIR ? undefined : parentOf(entry.path).slice(PRIVATE_DIR.length + 1)}
        end={folderControl(entry.path)} />, ...privateRows(entry.path)]
      : [fileRow(entry, PRIVATE_DIR)]))
  }

  /** The paths of Private's file rows on screen (each opened folder's files follow it, as `privateRows` lays them out). */
  const privateFiles = (dir: string): string[] => {
    const open = privateOpen[dir]
    if (open?.status !== 'ready') return []
    return open.entries.flatMap(entry => (entry.type === 'directory' ? privateFiles(entry.path) : [entry.path]))
  }
  const folderOfPlace = place.startsWith('folder:') ? place.slice('folder:'.length) : null
  const sectionOfPlace: DriveSection = place === 'private' ? 'captures' : folderOfPlace === null ? place as DriveSection : 'documents'
  /** The rows of a section or a Documents folder. */
  const placeRows = (): DriveEntry[] => (folderOfPlace === null
    ? bySection[sectionOfPlace]
    : bySection.documents.filter(entry => entry.path.startsWith(folderOfPlace + '/')))
  // BACK NEVER GOES DEAD: Back is offered, and Escape in the preview is taken, only while the row that
  // opened the preview is in the list on screen. After a tap on another place it is not, so there is no Back and
  // Escape falls through to Media; going back to that place brings Back again.
  const rowPaths = ready === null ? [] : place === 'private' ? privateFiles(PRIVATE_DIR) : placeRows().map(entry => entry.path)
  const canGoBack = openedFrom !== null && rowPaths.includes(openedFrom)

  // Escape inside the preview goes back to the row (before Media's own Escape, which closes the app); only a move that
  // happened keeps the Escape from Media.
  const previewKeys = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || !canGoBack) return
    if (back()) event.preventDefault()
  }

  const listBody = (): ReactNode => {
    if (listing.status === 'loading') return <p className={css.message}>{t('drive.reading')}</p>
    if (listing.status === 'failed') {
      return <p className={css.message} data-drive-failure={listing.reason}>{failureLine(listing.reason, CAPTURES_DIR, null)}</p>
    }
    if (place === 'private') {
      const root = privateOpen[PRIVATE_DIR]
      if (root === undefined) {
        return (
          <RecordList>
            <RecordRow tone="muted" title={t('drive.private')} summary={t('drive.privateSummary')} end={folderControl(PRIVATE_DIR)} />
          </RecordList>
        )
      }
      if (root.status === 'loading') return <p className={css.message}>{t('drive.reading')}</p>
      if (root.status === 'failed') return <p className={css.message}>{failureLine(root.reason, PRIVATE_DIR, null)}</p>
      const failed = Object.values(privateOpen).find(open => open.status === 'failed')
      return (
        <>
          {root.entries.length === 0 ? <p className={css.message}>{t('drive.emptyPrivate')}</p> : <RecordList>{privateRows(PRIVATE_DIR)}</RecordList>}
          {failed?.status === 'failed' ? <p className={css.message}>{failureLine(failed.reason, PRIVATE_DIR, null)}</p> : null}
        </>
      )
    }
    const section = sectionOfPlace
    const rows = placeRows()
    const root = folderOfPlace ?? SECTION_ROOT[section]
    return (
      <>
        {rows.length === 0
          ? <p className={css.message}>{t(SECTION_EMPTY[section])}</p>
          : <RecordList>{rows.map(entry => fileRow(entry, root))}</RecordList>}
        {place === 'captures' ? <p className={css.note}>{t('drive.ring')}</p> : null}
        {ready?.truncated === true ? <p className={css.note}>{fill('drive.truncated', { n: String(shownCount) })}</p> : null}
      </>
    )
  }

  const placeTitle = (): string => {
    if (place === 'private') return t('drive.private')
    if (place.startsWith('folder:')) return nameOf(place)
    return t(`drive.${place}` as MediaKey)
  }

  const previewBody = (): ReactNode => {
    if (selection === null || body === null) return <p className={css.message}>{t('drive.choose')}</p>
    switch (body.kind) {
      // One loading line at a time: while the list says it, the preview waits without saying it again.
      case 'loading': return listing.status === 'loading' ? null : <p className={css.message}>{t('drive.reading')}</p>
      case 'refused': return <p className={css.message}>{body.text}</p>
      case 'private': return (
        <>
          <p className={css.message}>{t('drive.inPrivate')}</p>
          <div className={css.actions}>
            <ActionControl tone="gold" data-drive-reveal="" onClick={() => { setRevealed(true) }}>{t('drive.showPreview')}</ActionControl>
          </div>
        </>
      )
      case 'message': return <p className={css.message}>{body.text}</p>
      case 'markdown': return (
        <div className={css.markdown}>
          <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={openFile}>
            <MarkdownText text={inertImages(body.text)} labels={MARKDOWN_LABELS} />
          </MarkdownDelegateProvider>
        </div>
      )
      case 'text': return <pre className={css.text}>{body.text}</pre>
      case 'image': return <ImagePreview url={body.url} name={nameOf(selection.path)} />
    }
  }

  const refused = selection === null ? null : refusalOf(selection.path)
  const shownPath = selection !== null && refused === null ? selection.path : null
  const missing = body?.kind === 'message' && !body.download && size === null
  const meta = shownPath !== null && !missing
  const entry = shownPath === null ? undefined : entryAt(shownPath)
  const kind = shownPath === null ? null : driveKind(shownPath)
  const fileSize = size ?? entry?.size ?? null
  const canDownload = shownPath !== null && body !== null && body.kind !== 'private' && !(body.kind === 'message' && !body.download)

  return (
    <div className={css.drive} data-media-drive="" ref={driveRef}>
      <div className={css.grid}>
        <Panel className={css.places}>
          <div className={css.placeTabs} role="tablist" aria-orientation="vertical" aria-label={t('drive.places')}>
            {placeControl('captures', t('drive.captures'), bySection.captures.length)}
            {placeControl('documents', t('drive.documents'), bySection.documents.length)}
            {folders.map(folder => placeControl(`folder:${folder.path}`, folder.name, null, true))}
            {placeControl('images', t('drive.images'), bySection.images.length)}
            {placeControl('video', t('drive.video'), bySection.video.length)}
            {ready?.privatePresent === true || place === 'private' ? placeControl('private', t('drive.private'), null) : null}
          </div>
          <p className={css.note}>{t('drive.readOnly')}</p>
        </Panel>
        <Panel className={css.list}>
          <SectionHeader className={css.header}>
            <h3>{placeTitle()}</h3>
            <ActionControl tone="blue" data-drive-refresh="" onClick={() => {
              setPrivateOpen({})
              setRefreshes(count => count + 1)
              // The selected file is read again too (a Private file closes again, like Private itself).
              if (selection !== null) select(selection.path)
            }}>
              <MediaIcon kind="refresh" />{t('drive.refresh')}
            </ActionControl>
          </SectionHeader>
          <div data-drive-list="" data-state={listing.status}>{listBody()}</div>
        </Panel>
      </div>
      <div onKeyDown={previewKeys} ref={previewCard} data-drive-preview-card="">
        <Panel className={css.preview} data-drive-preview="">
          <SectionHeader className={css.header}>
            <h3 ref={previewHeading} tabIndex={-1} data-drive-preview-heading="">{t('drive.preview')}</h3>
            {shownPath === null && !canGoBack ? null : (
              <div className={css.actions}>
                {canGoBack ? (
                  <ActionControl tone="blue" data-drive-back="" onClick={() => { back() }}>{t('drive.back')}</ActionControl>
                ) : null}
                {shownPath === null ? null : (
                  <ActionControl tone="blue" data-drive-copy="" onClick={copyPath}>
                    <MediaIcon kind="copy" />{copy === 'copied' ? t('drive.copied') : t('drive.copyPath')}
                  </ActionControl>
                )}
                {canDownload ? (
                  <ActionControl tone="mint" data-drive-download="" disabled={downloading} onClick={download}>
                    <MediaIcon kind="download" />{downloading ? t('drive.downloading') : t('drive.download')}
                  </ActionControl>
                ) : null}
              </div>
            )}
          </SectionHeader>
          {meta && kind !== null ? (
            <FieldTable rows={[
              [t('drive.name'), nameOf(shownPath)],
              [t('drive.kind'), kind.label],
              ...(fileSize === null ? [] : [[t('drive.size'), formatSize(fileSize)] as const]),
              ...(entry?.modifiedMs == null ? [] : [[t('drive.changedAt'), formatTime(entry.modifiedMs, now)] as const]),
              [t('drive.path'), <Mono key="p">{shownPath}</Mono>],
            ]} />
          ) : null}
          <div className={css.body} data-drive-body="" aria-busy={body?.kind === 'loading' || undefined} onClickCapture={guardLinks} onAuxClickCapture={guardLinks}>{previewBody()}</div>
          {copy === 'failed' ? <p className={css.message}>{t('drive.copyFailed')}</p> : null}
          {downloadNote === null ? null : <p className={css.message} data-drive-note="">{downloadNote}</p>}
        </Panel>
      </div>
      {/* Always on the page, so a file a chat link opens is announced when the line changes. */}
      <p className={css.announce} role="status" aria-live="polite" data-drive-announce="">{announcement}</p>
    </div>
  )
}

/** A raster image from its typed blob; if the browser cannot draw it, it says so. */
function ImagePreview({ url, name }: { readonly url: string; readonly name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p className={css.message}>{t('drive.imageFailed')}</p>
  return <img className={css.image} src={url} alt={name} onError={() => { setFailed(true) }} />
}
