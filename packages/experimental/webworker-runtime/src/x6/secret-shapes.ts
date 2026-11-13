/**
 * The one secret-shape filter for text that one of her read tools carries out of a stored thread: `x6_threads` (every
 * line he and she said) and `x6_browser_estate` search (its snippets) both import it, so there is one implementation and
 * one test table (tests/x6/secret-shapes.spec.ts).
 *
 * Secret-shaped runs leave as `[withheld]`: PEM blocks (also inside a JSON row, where their line breaks are `\n`),
 * `nsec1…`, `sk-…`, and 40 or more base64 or hex characters. Apply it to a whole text BEFORE any cut: a cut through a
 * key can leave a piece too short for any shape.
 * @module x6/secret-shapes
 */

export const WITHHELD = '[withheld]'

const SECRET_SHAPES: readonly RegExp[] = Object.freeze([
  /-----BEGIN [^\r\n-]{1,64}-----[\s\S]*?(?:-----END [^\r\n-]{1,64}-----|$)/g,
  /nsec1[0-9a-z]{6,}/gi,
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /[A-Za-z0-9+/]{40,}={0,2}/g,
  /[A-Za-z0-9_-]{40,}/g,
])

/**
 * Replace every secret-shaped run with `[withheld]`.
 * @param text - text about to leave a read tool, whole (not yet cut).
 * @returns the text with secret-shaped runs withheld.
 */
export function withholdSecrets(text: string): string {
  let out = text
  for (const shape of SECRET_SHAPES) out = out.replace(shape, WITHHELD)
  return out
}
