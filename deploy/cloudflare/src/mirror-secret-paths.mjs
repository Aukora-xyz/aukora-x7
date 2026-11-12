/**
 * SECRET-SHAPED PATH PARTS, for the readers that cannot import mirror-do.mjs: head-do.mjs (mirror-do
 * imports it, and its limits are read while mirror-do loads, so the reverse import would fail), cold-archive.mjs (same
 * cycle, through head-do) and server/local-host.mjs. This module imports nothing. It is a copy of mirror-do.mjs
 * `MIRROR_SECRET_NAMES` / `MIRROR_SECRET_PREFIXES` / `MIRROR_SECRET_SUFFIX` / `secretShapedPart`;
 * __tests__/mirror-secret-paths.test.mjs fails when the two differ.
 *
 * THE SECRET-PATH RULE. A path part is secret-shaped when it is
 *   STEM, then zero or more SUFFIX segments, then an optional single trailing `~`, where
 *   - STEM is a secret name (`.credentials.yaml`, `session.cap`, ...) or a secret name with ONE extra leading dot
 *     (`.session.cap`, `..credentials.yaml`);
 *   - a SUFFIX segment is one of `.` `~` `_` `-` followed by one token from a closed list: 6 to 64 hex characters, digits
 *     only, or tmp, temp, lock, bak, backup, old, new, next, prev, orig, swp, swo, part, partial, takeover
 *     (`.credentials.yaml.3fa9c1d2e4b5.tmp`, `.credentials.yaml.lock.takeover-0123456789abcdef`, `.ssh.bak`);
 *   - the trailing `~` may follow the stem (`.session.cap~`) or the last suffix segment (`credentials.yaml.bak~`);
 * or it starts with `.env`, `.aukora-` or `pepper.v1.` (the prefix rules, as on main: a wider family than this grammar).
 * Nothing else: `credentials.yaml-notes.md`, `session.cap.md`, `.transport-notes`, `.ssh-config-docs`, `.session.capx`,
 * `session.cap.takeover-notes.md` are ordinary names and reach her cloud like any other file.
 * @module mirror-secret-paths
 */
export const MIRROR_SECRET_NAMES = Object.freeze(['.credentials.yaml', 'credentials.yaml', 'session.cap', '.afferent-probe', 'ed25519-keypair.json', '.credentials', '.ssh', '.aws', '.transport', 'pepper.v1'])
export const MIRROR_SECRET_PREFIXES = Object.freeze(['.env', '.aukora-', 'pepper.v1.'])
/**
 * What may follow a stem: zero or more suffix segments (a mark, then a token from the closed list), then at most one `~`.
 * Each token has exactly ONE way to match (digits are written as 1 to 5 or 65 and more, since 6 to 64 digits are already
 * hex; no word is hex), a mark starts every segment, and a lone `~` at the end cannot start a segment (a token must follow
 * one), so no string matches two alternatives of one position: the engine never retries a split and the time stays linear
 * in the name. With `[0-9]+` beside the hex token, a chain of digit segments ending in a wrong character took 2^n tries.
 * Every copy says the same.
 */
export const MIRROR_SECRET_SUFFIX = /^(?:[.~_-](?:[0-9a-fA-F]{6,64}|[0-9]{1,5}|[0-9]{65,}|tmp|temp|lock|bak|backup|old|new|next|prev|orig|swp|swo|part|partial|takeover))*~?$/

/**
 * The rule's version. Snapshot ETags carry it (mirror-do.mjs snapshotETag), so a validator issued under an older rule
 * never gets 304 for bytes this rule filters differently. Bump it whenever the rule's language changes; the edge test
 * pins the rule's fingerprint per version and fails until it is bumped.
 */
export const MIRROR_SECRET_RULE_VERSION = 5

/** The secret name a part is, or derives from by the rule's stem, suffixes and tilde (the longest that fits), or null. Prefixes aside. */
export const secretFamily = part => {
  if (typeof part !== 'string') return null
  let found = null
  for (const name of MIRROR_SECRET_NAMES) {
    const fits = [name, '.' + name].some(stem => part.startsWith(stem) && MIRROR_SECRET_SUFFIX.test(part.slice(stem.length)))
    if (fits && (found === null || name.length > found.length)) found = name
  }
  return found
}

/** Whether one path part is a secret name, a temp, lock, backup or swap sibling of one, or carries a secret prefix. */
export const secretShapedPart = part => typeof part === 'string'
  && (MIRROR_SECRET_PREFIXES.some(prefix => part.startsWith(prefix)) || secretFamily(part) !== null)

/** Whether any part of a slash-separated path is secret-shaped. */
export const secretShapedPath = path => typeof path === 'string' && path.split('/').some(secretShapedPart)
