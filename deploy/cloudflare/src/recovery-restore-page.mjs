/**
 * The page an owner sees on an EMPTY edge (not seeded yet, or wiped): restore Auma from a recovery snapshot file.
 * Served only to an owner who already passed edge access, only for a document navigation, only while the edge is truly
 * empty or holds an unfinished restore. Its script is a generated plain string of `recoveryRestoreKit` and
 * `recoveryRestorePage` as written (recovery-restore-page.script.mjs; regenerate with
 * `node deploy/cloudflare/src/recovery-restore-page.generate.mjs`); the CSP admits exactly those script and style bytes
 * by hash. Text goes on the page through textContent only.
 * @module recovery-restore-page
 */
import { RECOVERY_RESTORE_PAGE_SCRIPT } from './recovery-restore-page.script.mjs'

const STYLE = `
* { box-sizing: border-box; }
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { margin: 0; padding: 24px; min-height: 100vh; display: grid; place-items: center; }
main { width: 100%; max-width: 40rem; }
h1 { font-size: 1.5rem; font-weight: 500; }
label, input, button { display: block; width: 100%; }
input, button { margin-top: 8px; padding: 12px; font: inherit; border: 1px solid; border-radius: 6px; }
input[type=checkbox] { display: inline; width: auto; margin-right: 8px; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .6; }
:focus-visible { outline: 3px solid Highlight; outline-offset: 3px; }
#restore-detail p { margin: 4px 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
#restore-status { min-height: 3em; font-weight: 500; }
`

// A plain string, generated from the kit and the glue as written: bundling (Wrangler's keepNames) never rewrites it.
const SCRIPT = RECOVERY_RESTORE_PAGE_SCRIPT
/** What the page says first: the edge's state, exactly. */
export const RECOVERY_RESTORE_INTROS = Object.freeze({
  empty: 'This edge holds no HEAD and no mirror yet.',
  resumable: 'This edge holds an unfinished restore: its HEAD is prepared and its mirror is not complete. Pick the same snapshot file to finish it; any other file is refused.',
})
const htmlFor = intro => '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>Restore Auma</title><style>' + STYLE + '</style></head>\n<body><main><h1>Restore Auma</h1>'
  + '<p>' + intro + ' Pick a recovery snapshot file (from Continuity). Every part is checked against its SHA-256, and this edge checks the whole import, before anything is written; nothing is written until you confirm.</p>'
  + '<label for="restore-file">Recovery snapshot (.json)</label><input id="restore-file" type="file" accept="application/json,.json">'
  + '<button id="restore-check" type="button" disabled>Check the file</button>'
  + '<div id="restore-detail" aria-live="polite"></div>'
  + '<p><label><input id="restore-confirm" type="checkbox">I am the owner and I want to write this snapshot into this edge.</label></p>'
  + '<button id="restore-go" type="button" disabled>Restore</button>'
  + '<p id="restore-status" role="status" aria-live="polite" aria-atomic="true"></p>'
  + '</main><noscript>Enable JavaScript to restore. Nothing can be written without it.</noscript><script>' + SCRIPT + '</script></body></html>'
const HTML = htmlFor(RECOVERY_RESTORE_INTROS.empty)
const RESUMABLE_HTML = htmlFor(RECOVERY_RESTORE_INTROS.resumable)

/**
 * Which page an owner's document navigation gets on a not-ready edge: 'empty' (both HEAD and mirror empty), 'resumable'
 * (HEAD prepared, mirror empty or receiving the same seed), or null (established or mismatched: never this page).
 * @param bootstrap - the Worker's `bootstrapStatus` answer.
 * @returns the mode or null.
 */
export function recoveryRestorePageMode(bootstrap) {
  const head = bootstrap?.head, mirror = bootstrap?.mirror
  if (bootstrap?.ready !== false || !head || !mirror) return null
  if (head.phase === 'empty' && mirror.phase === 'empty') return 'empty'
  if (head.phase === 'prepared' && (mirror.phase === 'empty' || (['receiving', 'ready'].includes(mirror.phase) && mirror.seedId === head.seedId))) return 'resumable'
  return null
}

const cspHash = async text => 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))))
// Only the RESOLVED policy text is held between requests, never a pending promise: a promise left here by a request the
// runtime then cancels would never settle. A request that finds no text computes it itself (two SHA-256 digests).
let policy = null

/** The page's exact script and markup (tests read them). */
export const RECOVERY_RESTORE_PAGE = Object.freeze({ html: HTML, resumableHtml: RESUMABLE_HTML, script: SCRIPT, style: STYLE })

/** The restore page response: no-store, no referrer, a CSP that admits only this script and style. */
export async function recoveryRestorePageResponse(mode = 'empty') {
  let csp = policy
  if (csp === null) {
    const [script, style] = await Promise.all([cspHash(SCRIPT), cspHash(STYLE)])
    csp = policy = `default-src 'none'; base-uri 'none'; object-src 'none'; script-src '${script}'; style-src '${style}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`
  }
  return new Response(mode === 'resumable' ? RESUMABLE_HTML : HTML, { status: 503, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'content-security-policy': csp,
  } })
}
