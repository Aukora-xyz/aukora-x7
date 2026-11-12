/**
 * The `/rescue` page: a checked second copy of the browser it is opened in, made without starting her app. Served (once
 * the Worker wires it) only to a signed-in owner, only for a document navigation. Its script is the generated plain string of
 * `rescueKit` and `rescuePage` as written (rescue-page.script.mjs; regenerate with
 * `node deploy/cloudflare/src/rescue-page.generate.mjs`); the CSP admits exactly that script and this style by hash. Text
 * reaches the page through textContent only, and nothing here links or goes to `/`.
 * @module rescue-page
 */
import { RESCUE_PAGE_SCRIPT } from './rescue-page.script.mjs'

// THE SPATIAL LOOK, carried by value from OWNER_SIGNIN_STYLE in worker.mjs (each line names the token it came from). No
// file, no font: the CSP admits only this block by its hash.
const STYLE = `
* { box-sizing: border-box; }
[hidden] { display: none; }
:root {
  color-scheme: dark;
  /* --dsh-font-family-text-default (base.css) */
  font: 100%/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  /* --aukora-text */
  color: rgb(232, 234, 237);
  /* --aukora-background */
  background-color: rgb(11, 13, 24);
}
body {
  margin: 0; padding: 16px; min-height: 100vh; display: grid; place-items: center;
  /* --dsw-specific-spatial-canvas, dark: --dsw-static-spatial-night-900 / -850 / -950 under the mint, violet and blue glows */
  background:
    radial-gradient(1200px 800px at 18% -10%, rgba(129, 212, 180, 0.1), transparent 60%),
    radial-gradient(1100px 760px at 82% 110%, rgba(196, 170, 255, 0.12), transparent 60%),
    radial-gradient(900px 700px at 50% 50%, rgba(150, 180, 255, 0.07), transparent 65%),
    linear-gradient(160deg, rgb(9, 10, 18) 0%, rgb(11, 13, 24) 55%, rgb(8, 9, 16) 100%);
  background-color: rgb(11, 13, 24);
}
main {
  width: 100%; max-width: 34rem; padding: clamp(20px, 6vw, 36px);
  /* --dsw-specific-spatial-lane (dark) on --aukora-border, --dsw-radius-panel */
  background: rgba(255, 255, 255, 0.043); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 28px;
}
h1 {
  margin: 0; font-size: 1.75rem; font-weight: 600; line-height: 1.2;
  /* --dsw-static-neutral-bluish-00 */
  color: rgb(255, 255, 255);
}
.lede {
  margin: 6px 0 20px; font-size: 1rem;
  /* --dsw-static-spatial-blue (--aukora-blue) */
  color: rgb(150, 180, 255);
}
h2 { margin: 20px 0 8px; font-size: 1.0625rem; font-weight: 600; color: rgb(255, 255, 255); }
p { margin: 0; overflow-wrap: anywhere; }
button {
  display: block; width: 100%; margin-top: 12px; padding: 12px 16px; font: inherit; line-height: 1.4;
  /* --dsw-radius-md */
  border-radius: 12px;
  /* --ds-transition-duration, --ds-ease-in-out */
  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: pointer; font-weight: 500;
  /* --dsw-specific-spatial-lane (dark), --aukora-text-muted, --aukora-text */
  background: rgba(255, 255, 255, 0.043); border: 1px solid rgb(139, 144, 153); color: rgb(232, 234, 237);
}
button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
#rescue-cloud {
  margin-top: 24px; padding: 14px 16px; font-weight: 600;
  /* --dsw-static-spatial-blue fill, --dsw-static-spatial-night-950 label */
  background: rgb(150, 180, 255); border-color: rgb(150, 180, 255); color: rgb(8, 9, 16);
}
/* --dsw-static-deepseek-300 */
#rescue-cloud:hover:not(:disabled) { background: rgb(183, 200, 254); border-color: rgb(183, 200, 254); }
button:disabled { cursor: wait; opacity: 0.6; }
/* --dsw-static-spatial-blue */
:focus-visible { outline: 3px solid rgb(150, 180, 255); outline-offset: 3px; }
a { color: rgb(150, 180, 255); }
[role="status"] {
  margin-top: 16px; min-height: 3em; font-variant-numeric: tabular-nums;
  /* --aukora-text-secondary */
  color: rgb(184, 188, 196);
}
#rescue-detail p, #rescue-left-list p {
  margin-top: 4px; font-size: 0.9375rem; font-variant-numeric: tabular-nums;
  /* --aukora-text-secondary */
  color: rgb(184, 188, 196);
}
#rescue-left { margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.1); }
noscript { display: block; margin-top: 16px; color: rgb(184, 188, 196); }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
@media (forced-colors: active) {
  main, button { border: 1px solid CanvasText; }
  :focus-visible { outline-color: Highlight; }
}
`

// A plain string, generated from the kit and the glue as written: bundling (Wrangler's keepNames) never rewrites it.
const SCRIPT = RESCUE_PAGE_SCRIPT
const HEAD = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>Rescue copy</title><style>' + STYLE + '</style></head>\n'
const HTML = HEAD + '<body><main><h1>A second copy of this browser</h1><p class="lede">Rescue copy</p>'
  + '<p>This page copies what this browser holds of hers: every thread, every home file, her storage’s own records and her Auma Live chat logs. Other saved settings stay in this browser. '
  + 'Secret files (her keys, sign-in files and anything named like them; for her cloud, also files named like keys, secrets, credentials or passwords) are left in this browser only; they are listed below by kind, never by name or content. '
  + 'Every piece is checked against its SHA-256 and read back. Nothing in this browser is changed: this page only reads, and it does not start her app.</p>'
  + '<button id="rescue-cloud" type="button" disabled>Copy to her cloud</button>'
  + '<button id="rescue-local" type="button" disabled>Save a copy on this computer</button>'
  + '<p id="rescue-status" role="status" aria-live="polite" aria-atomic="true"></p>'
  + '<button id="rescue-signin" type="button" hidden>Sign in again</button>'
  + '<div id="rescue-detail" aria-live="polite"></div>'
  + '<section id="rescue-left" aria-labelledby="rescue-left-heading" hidden><h2 id="rescue-left-heading">Left in this browser only</h2><div id="rescue-left-list"></div></section>'
  + '</main><noscript>Enable JavaScript to make a copy. Nothing can be read without it.</noscript><script>' + SCRIPT + '</script></body></html>'
const BUSY_HTML = HEAD + '<body><main><h1>A second copy of this browser</h1><p class="lede">Rescue copy</p>'
  + '<p role="status">Her edge is busy. Try again.</p><p><a href="/rescue">Try again</a></p></main></body></html>'

/** The page's exact script, style and markup (tests read them). */
export const RESCUE_PAGE = Object.freeze({ html: HTML, busyHtml: BUSY_HTML, script: SCRIPT, style: STYLE })

const cspHash = async text => 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))))
// Only RESOLVED policy text is held between requests, never a pending promise: a promise left here by a request the
// runtime then cancels would never settle. A request that finds no text computes it itself.
let pagePolicy = null
let busyPolicy = null
const HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }

/** The `/rescue` page: 200, no-store, no referrer, a CSP that admits only this script and this style. */
export async function rescuePageResponse() {
  let csp = pagePolicy
  if (csp === null) {
    const [script, style] = await Promise.all([cspHash(SCRIPT), cspHash(STYLE)])
    csp = pagePolicy = `default-src 'none'; base-uri 'none'; object-src 'none'; script-src '${script}'; style-src '${style}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`
  }
  return new Response(HTML, { status: 200, headers: { ...HEADERS, 'content-security-policy': csp } })
}

/** The edge could not read its key just now: 503, retry in a second, a small page in the same look, no script. */
export async function rescueBusyResponse() {
  let csp = busyPolicy
  if (csp === null) {
    csp = busyPolicy = `default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'none'; style-src '${await cspHash(STYLE)}'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'`
  }
  return new Response(BUSY_HTML, { status: 503, headers: { ...HEADERS, 'retry-after': '1', 'content-security-policy': csp } })
}

/**
 * True only for a `GET /rescue` document navigation: `sec-fetch-mode` absent or `navigate`, `sec-fetch-dest` absent or
 * `document`, and exactly one `text/html` (with a quality above zero) in `accept`. Query values are never read.
 * @param {Request} request
 * @param {URL} url
 */
export function wantsRescueDocument(request, url) {
  if (request.method !== 'GET' || url.pathname !== '/rescue') return false
  const mode = request.headers.get('sec-fetch-mode'), destination = request.headers.get('sec-fetch-dest')
  if ((mode !== null && mode !== 'navigate') || (destination !== null && destination !== 'document')) return false
  const html = (request.headers.get('accept') || '').split(',').map(value => value.trim()).filter(value => value.split(';')[0].trim().toLowerCase() === 'text/html')
  if (html.length !== 1) return false
  const match = /^text\/html(?:\s*;\s*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/i.exec(html[0])
  return match !== null && (match[1] === undefined || Number(match[1]) > 0)
}
