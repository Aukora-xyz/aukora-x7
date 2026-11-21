/**
 * The one secret-shape filter for text that one of her read tools carries out of a stored thread: `x6_threads` (every
 * line he and she said) and `x6_browser_estate` search (its snippets) both import it, so there is one implementation and
 * one test table (tests/x6/secret-shapes.spec.ts).
 *
 * Secret-shaped runs leave as `[withheld]`: PEM blocks (also inside a JSON row, where their line breaks are `\n`),
 * `nsec1…`, `sk-…`, the value of a key-like UPPER_CASE assignment, and 40 or more base64 or hex characters (except an
 * ordinary id, slug or path: `ordinaryRun`). Apply it to a whole text BEFORE any cut: a cut through a
 * key can leave a piece too short for any shape.
 * @module x6/secret-shapes
 */

export const WITHHELD = '[withheld]'

/**
 * The end of a PEM block: its END line; else the first quote not escaped by a backslash, so a BEGIN
 * line with no END inside a JSON string withholds only the rest of that string and the JSON stays whole; else the end of
 * the text.
 */
const PEM = /-----BEGIN [^\r\n-]{1,64}-----[\s\S]*?(?:-----END [^\r\n-]{1,64}-----|(?<=(?:^|[^\\])(?:\\\\)*)(?=")|$)/g
/** An assignment of a key-like UPPER_CASE name (`CF_API_KEY=…`, `GITHUB_TOKEN: …`): its value, of 16 or more characters
 * holding a digit, is withheld whatever its length or alphabet (a 32- or 37-hex key is shorter than the long-run shapes). */
const ASSIGNED_NAME = String.raw`\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)`
const ASSIGNED = new RegExp(String.raw`${ASSIGNED_NAME}(\s*[=:]\s*["']?)(?=[A-Za-z0-9+/=_.-]*\d)[A-Za-z0-9+/=_.-]{16,}`, 'g')
const SHORT_SHAPES: readonly RegExp[] = Object.freeze([
  /nsec1[0-9a-z]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{6,}/g,
])
/** The long-run shapes: 40 or more base64, or base64url / hex, characters in one unbroken run. */
const LONG_SHAPES: readonly RegExp[] = Object.freeze([
  /[A-Za-z0-9+/]{40,}={0,2}/g,
  /[A-Za-z0-9_-]{40,}/g,
])

/** A commit id or a SHA-256 digest: lowercase hex, exactly 40 or 64 characters. */
const ID_HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** What names an id on the same line just before it (`"sha": "`, `commit `, `headSha=`, `"id":"`, `ballId`, ...). */
const ID_CUE = /(?:sha|commit|head|base|parent|revision|digest|hash|chain|tail|ball|oid|tree|blob|merge|ref|\bid\b|[a-z]id\b)/i
/** What names a secret just before it: such a run is withheld even when it is shaped like an id. */
const SECRET_CUE = /(?:secret|key|token|passw|priv|nsec|auth|bearer|credential|cookie|salt|seed|signature|api)/i
/** Lower-case words or numbers joined by single dashes (a Linear slug, `thread-<uuid>`): segments of at most 24. */
const KEBAB = /^[a-z0-9]{1,24}(?:-[a-z0-9]{1,24}){2,}$/
/** A path segment: lower-case letters and digits, or letters only, at most 24. */
const PATH_SEGMENT = /^(?:[a-z0-9]{1,24}|[A-Za-z]{1,24})$/
const PATH_ID_CUE = new Set(['commit', 'commits', 'blob', 'tree', 'compare', 'objects', 'sha', 'sha256'])

/** The text on the same line before `offset`, back to the nearest `,` `;` `{` `[` or line break (at most 40 characters). */
function cueBefore(whole: string, offset: number): string {
  const line = whole.slice(Math.max(0, offset - 40), offset)
  const cut = Math.max(...[',', ';', '{', '[', '\n'].map(mark => line.lastIndexOf(mark)))
  return line.slice(cut + 1)
}

/**
 * A long run that is an ordinary id, never a
 * bearer secret, is kept: a commit id or SHA-256 digest named as one just before it (and not named as a key or secret),
 * lower-case dashed words (a slug, a prefixed UUID; a bare UUID is shorter than 40 and always passed), and a path of
 * lower-case or letter-only segments (with a commit id or digest only after a `commit`, `blob`, `tree` segment).
 */
function ordinaryRun(run: string, whole: string, offset: number): boolean {
  if (KEBAB.test(run)) return true
  const before = cueBefore(whole, offset)
  if (SECRET_CUE.test(before)) return false
  if (ID_HEX.test(run)) return ID_CUE.test(before)
  const segments = run.split('/')
  if (segments.filter(segment => segment !== '').length < 3) return false
  return segments.every((segment, index) => segment === '' || PATH_SEGMENT.test(segment)
    || (ID_HEX.test(segment) && PATH_ID_CUE.has(segments[index - 1] ?? '')))
}

/**
 * Replace every secret-shaped run with `[withheld]`.
 * @param text - text about to leave a read tool, whole (not yet cut).
 * @returns the text with secret-shaped runs withheld.
 */
export function withholdSecrets(text: string): string {
  let out = text.replace(PEM, WITHHELD).replace(ASSIGNED, (_match, name: string, sep: string) => `${name}${sep}${WITHHELD}`)
  for (const shape of SHORT_SHAPES) out = out.replace(shape, WITHHELD)
  const screen = (run: string, offset: number, whole: string): string => ordinaryRun(run, whole, offset) ? run : WITHHELD
  for (const shape of LONG_SHAPES) out = out.replace(shape, screen)
  return out
}
