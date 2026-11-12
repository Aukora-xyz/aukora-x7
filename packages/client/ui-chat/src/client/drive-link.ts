// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * HER CHAT'S FILE LINKS AND IMAGES OPEN HER DRIVE. When the Spatial shell is loaded (its `layout` service has
 * `openSurface`), a file link in her chat that names a path in her home folder (`/dsh/home/auma/...`) opens "Media and
 * Documents" at that file, in the centre Stage, instead of the right sidebar's text tab; and an image in her chat with
 * such a path loads through the same read channel as the drive (the files service: `stat`, then byte windows), into a
 * `blob:` URL, never through a network URL. Every other path, and any shell without `openSurface`, keeps the stock
 * behaviour exactly.
 *
 * The drive decides what it shows (its refusal lines for a secret-shaped name, a path outside its places, or one that is
 * not a plain path); a link only names the file. An image is refused HERE before any byte is read when the drive would
 * refuse it, when it is in Private (nothing in Private is read before the owner asks, in the drive), when it is not a
 * PNG, JPEG, WebP or GIF, or when it is over 16 MiB.
 *
 * THE DRIVE RULE between the markers is a VERBATIM copy of `ui-layout/.../apps/media/drive-rule.ts` (this package cannot
 * import ui-layout); `ui-layout/tests/media-drive-rule.client.spec.ts` pins the two copies equal.
 *
 * @module ui-chat/drive-link
 */

// BEGIN DRIVE RULE
/** Secret file and folder names (mirror rule v5). */
export const SECRET_NAMES: readonly string[] = [
  '.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe', 'ed25519-keypair.json', '.credentials', '.ssh', '.aws', '.transport',
  'pepper.v1',
]
/** A part starting with one of these is secret-shaped. */
export const SECRET_PREFIXES: readonly string[] = ['.env', '.aukora-', 'pepper.v1.']
/** What may follow a secret stem: temp, lock, backup and swap suffixes, then one optional `~`. Linear: one way to match. */
export const SECRET_SUFFIX =
  /^(?:[.~_-](?:[0-9a-fA-F]{6,64}|[0-9]{1,5}|[0-9]{65,}|tmp|temp|lock|bak|backup|old|new|next|prev|orig|swp|swo|part|partial|takeover))*~?$/
/** Names that look like keys or credentials (the estate's pattern), tested on every part. */
export const SENSITIVE_NAME = /(?:keypair|private[-_.]?key|secret|credential|password|\.pem$|\.key$|\.p12$|session\.cap$)/i
/**
 * The drive's own additions, tested on every part (a superset of the estate's and the mirror's rules): SSH key files,
 * dot-files that hold logins, anything named for a login key or an API key, a Nostr secret key, key stores, and her
 * secret stems (`session.cap`, `afferent-probe`, `pepper.v<n>`) with ANY extension after them.
 */
export const DRIVE_SECRET_NAME = new RegExp([
  '^id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[.~_-])',
  '^[._]?(?:npmrc|netrc|pgpass|pypirc)(?:$|[.~_-])',
  'token', 'api[-_.]?key', '(?:^|[^a-z0-9])nsec',
  '\\.(?:p8|pfx|kdbx|jks|keystore)$',
  '^\\.?session\\.cap[.~_-]', '^\\.*afferent-probe(?:$|[.~_-])', '^\\.?pepper\\.v[0-9]+(?:$|[.~_-])',
].join('|'), 'i')
/** Parts never shown. */
const NEVER_PARTS: readonly string[] = ['.DS_Store', 'session.lock']
/** Roots never shown. */
const NEVER_ROOTS: readonly string[] = ['/dsh/home/balls', '/dsh/home/sessions']
/** Her home: the drive opens nothing outside it. */
export const DRIVE_HOME = '/dsh/home/auma/'
/** Her private folder: one collapsed row; nothing in it is read before the owner asks. */
export const PRIVATE_DIR = '/dsh/home/auma/private'
/** The drive's places: it opens a file only inside one of these (her organs and her home folder's root are not files for a person). */
export const DRIVE_PLACES: readonly string[] = ['/dsh/home/auma/captures', '/dsh/home/auma/docs', PRIVATE_DIR]

/**
 * @param part - one path part.
 * @returns whether it is a secret name, a sibling of one, or carries a secret prefix.
 */
export function driveSecretPart(part: string): boolean {
  if (SECRET_PREFIXES.some(prefix => part.startsWith(prefix))) return true
  return SECRET_NAMES.some(name => [name, '.' + name].some(stem => part.startsWith(stem) && SECRET_SUFFIX.test(part.slice(stem.length))))
}

/**
 * @param path - an absolute path.
 * @returns true when the drive must never list, preview or download it.
 */
export function driveKeptOut(path: string): boolean {
  if (NEVER_ROOTS.some(root => path === root || path.startsWith(root + '/'))) return true
  return path.split('/').some(part => part !== '' && (
    driveSecretPart(part) || SENSITIVE_NAME.test(part) || DRIVE_SECRET_NAME.test(part) || NEVER_PARTS.includes(part)
    || part.endsWith('.conflict-backup')
  ))
}

/**
 * @param path - an absolute path, already canonical.
 * @returns whether it lies inside Captures, Documents or Private (the folders themselves are not files).
 */
export function driveInPlaces(path: string): boolean {
  return DRIVE_PLACES.some(place => path.startsWith(place + '/'))
}

/**
 * @param path - a path as a link or a listing gave it.
 * @returns true only for a plain absolute path: no empty, `.` or `..` segment, no trailing `/`, no `\`, no control character.
 */
export function driveCanonical(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\')) return false
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false
  return path.slice(1).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * @param path - an absolute path.
 * @returns whether it is her Private folder or inside it.
 */
export function drivePrivate(path: string): boolean {
  return path === PRIVATE_DIR || path.startsWith(PRIVATE_DIR + '/')
}

let driveTargets = 0
/**
 * @param path - the absolute path to open.
 * @returns a Media surface target; each call is new, so a second click on the same link selects the file again.
 */
export function driveTarget(path: string): string {
  driveTargets += 1
  return `drive:${String(driveTargets)}:${path}`
}

/**
 * @param target - a Media surface target.
 * @returns the path a `drive:<n>:<path>` target names, or null for anything else.
 */
export function parseDriveTarget(target: unknown): string | null {
  if (typeof target !== 'string') return null
  return /^drive:[0-9]+:(.+)$/su.exec(target)?.[1] ?? null
}
// END DRIVE RULE

/** The drive's surface id in the Spatial centre Stage. */
export const DRIVE_SURFACE = 'media'
/** The control beside an image that cannot be shown here. */
export const OPEN_IN_DRIVE_LABEL = 'Open in drive'
/** Largest image shown inline (the drive's own image preview cap). */
export const DRIVE_IMAGE_CAP = 16 * 1024 * 1024
/** Largest window one read asks for (the files service's window, as the drive reads). */
export const DRIVE_WINDOW = 2 * 1024 * 1024
/** The only image types shown inline; each Blob is typed with exactly one of these. */
const RASTER: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** The part of the Spatial layout service a drive link needs (structural: ui-chat does not import ui-layout). */
interface DriveLayout {
  readonly openSurface: (id: string, target?: string, presentation?: 'contained' | 'full-bleed') => void
}

type FilesResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
/** The two read methods of the stock files service an inline image uses (structural, as the drive's `DriveFiles`). */
export interface DriveImageFiles {
  stat(sessionId: string, path: string, signal: AbortSignal): Promise<
    FilesResult<{ absolutePath: string; version: string; bytes?: number }>
  >
  readBytes(sessionId: string, path: string, options: { range?: { offset?: number; length?: number } }, signal: AbortSignal): Promise<
    FilesResult<{ data: Uint8Array; version: string; eof: boolean }>
  >
}

/**
 * @param layout - the client's `layout` service, whatever shell provided it.
 * @returns it, when it is the Spatial shell's (it can open a centre-Stage surface at a target).
 */
function spatialLayout(layout: unknown): DriveLayout | null {
  if (layout === null || typeof layout !== 'object') return null
  return typeof (layout as Partial<DriveLayout>).openSurface === 'function' ? layout as DriveLayout : null
}

/**
 * WHICH LINKS THE DRIVE TAKES. A path under
 * her home folder goes to the drive only when it is in one of the drive's places, or when it must be refused (a
 * kept-out, secret-shaped name, or a path that is not plain): those never reach the right sidebar. Every other path in
 * her home folder (HANDOFF.md, NORTH-STAR.md, seed/<organ>.js, memory/..., staged/...) opens where it always did.
 * @param path - an absolute path, as the chat resolved it.
 * @returns whether a link to it belongs to her drive.
 */
export function driveOwnsPath(path: string): boolean {
  return path.startsWith(DRIVE_HOME) && (driveInPlaces(path) || driveKeptOut(path) || !driveCanonical(path))
}

/**
 * Open her drive at a file, when the Spatial shell is loaded and the path is in her home folder.
 * @param layout - the client's `layout` service.
 * @param path - the absolute path the link names.
 * @returns true when the drive was asked to open it (the caller then does nothing else); false keeps the stock behaviour.
 */
export function openInDrive(layout: unknown, path: string): boolean {
  const spatial = spatialLayout(layout)
  if (spatial === null || !driveOwnsPath(path)) return false
  spatial.openSurface(DRIVE_SURFACE, driveTarget(path), 'contained')
  return true
}

/**
 * Whether her drive takes this image (the Spatial shell is loaded and the path is in her home folder). A claimed image
 * never becomes a URL: it loads through `loadDriveImage` or shows its alt text.
 */
export function driveClaimsImage(layout: unknown, path: string): boolean {
  return spatialLayout(layout) !== null && driveOwnsPath(path)
}

/**
 * @param path - an absolute path.
 * @returns the raster type an inline image of it is shown as, or null when it is not shown inline.
 */
export function driveImageType(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? null : RASTER[name.slice(dot + 1).toLowerCase()] ?? null
}

/** Whether the drive would show this path's bytes inline without asking the owner first. */
function inlineAllowed(path: string): boolean {
  return driveCanonical(path) && path.startsWith(DRIVE_HOME) && driveInPlaces(path) && !driveKeptOut(path) && !drivePrivate(path)
}

/**
 * Read one image for her chat, as the drive reads: the drive rule first (zero calls when it refuses), then `stat`
 * (size, and the path the file really is), then byte windows of at most 2 MiB, one at a time, from one version.
 * @param files - the files service, or null when this client has none.
 * @param sessionId - the thread the image is shown in (the read goes through it), or undefined.
 * @param path - the absolute path.
 * @param signal - aborts the read (the image unmounted).
 * @returns a Blob typed PNG, JPEG, WebP or GIF, or null when it is refused, missing, changed or too large.
 */
export async function loadDriveImage(
  files: DriveImageFiles | null, sessionId: string | undefined, path: string, signal: AbortSignal, kept?: DriveImageKept,
): Promise<Blob | null> {
  const type = driveImageType(path)
  // Read through a function: the signal can abort while a call is out, after any check of it here.
  const stopped = (): boolean => signal.aborted
  if (type === null || !inlineAllowed(path) || files === null || sessionId === undefined || stopped()) return null
  try {
    const stat = await files.stat(sessionId, path, signal)
    if (!stat.ok || stopped()) return null
    const { bytes: size, version, absolutePath } = stat.value
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > DRIVE_IMAGE_CAP) return null
    // The file the path really is must pass the same rule (a link into Private or a kept-out file is refused).
    if (absolutePath !== path && (!inlineAllowed(absolutePath) || driveImageType(absolutePath) !== type)) return null
    // The same bytes, already read for another message: no byte is read again.
    const held = kept?.get(path, version)
    if (held !== undefined && held.type === type && held.size === size) return held
    const bytes = new Uint8Array(size)
    let offset = 0
    while (offset < size) {
      const window = { offset, length: Math.min(DRIVE_WINDOW, size - offset) }
      const read = await files.readBytes(sessionId, path, { range: window }, signal)
      if (!read.ok || stopped() || read.value.version !== version) return null
      const data = read.value.data
      if (data.byteLength === 0 || offset + data.byteLength > size) return null
      bytes.set(data, offset)
      offset += data.byteLength
    }
    const blob = new Blob([bytes], { type })
    kept?.put(path, version, blob)
    return blob
  } catch {
    return null
  }
}

/** Blobs already read, by (path, version): a hit is used instead of reading the bytes again. */
export interface DriveImageKept {
  get(path: string, version: string): Blob | undefined
  put(path: string, version: string, blob: Blob): void
}

/** At most this many image reads run at once in one thread; the rest wait their turn. */
export const DRIVE_IMAGE_READS = 2

/** One thread's image reader: one read per path at a time, at most two at once, one Blob per (path, version). */
export interface DriveImageShelf {
  /** The image as a typed Blob, or null; the same path asked for twice while it is read is read once. */
  read(path: string, signal: AbortSignal): Promise<Blob | null>
}

interface ShelfRead {
  readonly controller: AbortController
  readonly result: Promise<Blob | null>
  waiting: number
}

/**
 * HER IMAGES IN ONE THREAD, READ ONCE. Her turns often end with the
 * same `captures/latest.png`, so thirty messages may show one file. Every message asking for a path while it is read
 * waits on that one read; a read is aborted only when every message that asked has gone. At most `DRIVE_IMAGE_READS`
 * reads (stat, then byte windows) run at once. A Blob is kept by (path, version) only while something still holds it
 * (a `WeakRef`; where there is none, nothing is kept and a later message reads again), so a message mounted later
 * pays one `stat` and reads no byte when the file has not changed, and a changed file is read again.
 * @param files - the files service, read at each call (it may come later).
 * @param sessionId - the thread.
 * @returns the thread's reader.
 */
export function createDriveImageShelf(files: () => DriveImageFiles | null, sessionId: string | undefined): DriveImageShelf {
  const reading = new Map<string, ShelfRead>()
  const queue: (() => void)[] = []
  let running = 0
  const blobs = new Map<string, { deref(): Blob | undefined }>()
  const Ref = (globalThis as { WeakRef?: new (target: Blob) => { deref(): Blob | undefined } }).WeakRef
  const kept: DriveImageKept = {
    get: (path, version) => {
      const key = `${version}\n${path}`
      const blob = blobs.get(key)?.deref()
      if (blob === undefined) blobs.delete(key)
      return blob
    },
    put: (path, version, blob) => {
      if (Ref === undefined) return
      for (const [key, ref] of blobs) if (ref.deref() === undefined) blobs.delete(key)
      blobs.set(`${version}\n${path}`, new Ref(blob))
    },
  }
  /** Run `job` when a place is free; a job whose read was abandoned while it waited never runs. */
  const turn = <T>(signal: AbortSignal, job: () => Promise<T>, abandoned: T): Promise<T> => new Promise<T>((resolve) => {
    const start = (): void => {
      if (signal.aborted) { resolve(abandoned); next(); return }
      running += 1
      void job().then(resolve, () => { resolve(abandoned) }).finally(() => { running -= 1; next() })
    }
    if (running < DRIVE_IMAGE_READS) start()
    else queue.push(start)
  })
  const next = (): void => {
    if (running < DRIVE_IMAGE_READS) queue.shift()?.()
  }
  return {
    read(path, signal) {
      if (signal.aborted) return Promise.resolve(null)
      let shared = reading.get(path)
      if (shared === undefined) {
        const controller = new AbortController()
        const result = turn(controller.signal, () => loadDriveImage(files(), sessionId, path, controller.signal, kept), null)
        const entry: ShelfRead = { controller, result, waiting: 0 }
        void result.finally(() => { if (reading.get(path) === entry) reading.delete(path) })
        reading.set(path, entry)
        shared = entry
      }
      const entry = shared
      entry.waiting += 1
      return new Promise<Blob | null>((resolve) => {
        let done = false
        const leave = (): void => {
          if (done) return
          done = true
          entry.waiting -= 1
          if (entry.waiting === 0 && reading.get(path) === entry) {
            reading.delete(path)
            entry.controller.abort()
          }
          resolve(null)
        }
        signal.addEventListener('abort', leave, { once: true })
        void entry.result.then((blob) => {
          signal.removeEventListener('abort', leave)
          if (done) return
          done = true
          entry.waiting -= 1
          resolve(blob)
        })
      })
    },
  }
}
