// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * THE DRIVE RULE: what "Media and Documents" never lists, previews or downloads, and which paths it refuses to open at
 * all. Pure and dependency-free, so the chat's file links can carry a verbatim copy of the block between the markers
 * (a ui-layout spec pins the two copies equal once that copy exists).
 *
 * - A path part is SECRET-SHAPED when it starts with a secret prefix, or is a secret name (or that name with one extra
 *   leading dot) followed only by temp, lock, backup or swap suffixes (rule version 5, `mirror-secret-paths.mjs`,
 *   a superset of the names her IndexedDB mirror refuses).
 * - SENSITIVE_NAME (the estate's own pattern, `x6/browser-estate.ts`) is applied to EVERY part, folders included: the estate
 *   redacts only the last part, so `docs/credentials/api.txt` would come back unredacted.
 * - DRIVE_SECRET_NAME (the drive's own additions) is applied to every part too: SSH key files, login dot-files, login and
 *   API key names, Nostr secret keys, key stores, and her secret stems with any extension.
 * - Never parts and never roots: Finder droppings, her session lock, conflict backups, her balls, her transcripts.
 * - `driveInPlaces`: the drive opens a file only inside Captures, Documents or Private, never elsewhere in her home.
 * - `driveCanonical` refuses (never normalises) a path with an empty, `.` or `..` segment, a trailing `/`, a backslash or
 *   a control character: chat links are percent-decoded, and the worker's file system normalises after any check here,
 *   so `docs/../private/x` would otherwise skip the Private gate.
 *
 * @module apps/media/drive-rule
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
