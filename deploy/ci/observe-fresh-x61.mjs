#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * FRESH-WINDOW COLD-BOOT OBSERVER for x6.1 (ported from X63 scripts/observe-fresh.mjs, fresh-window-ui.mjs,
 * observe-surfaces.mjs and wait-release.mjs).
 *
 * For each engine (Chromium, Firefox, WebKit) it opens a brand-new browser context A, signs in, cold-boots the real
 * Spatial app and records what it sees; closes A; then does the same in a second brand-new context B. A context made by
 * browser.newContext() with no storageState starts with no cookies, localStorage or IndexedDB (a private window).
 * The pure verdict lives in ./observe-verdict.mjs.
 *
 * Live facts recorded per context (Wave 4E Lane E2): workspace { chip } is the label of the workspace chip after cold
 * boot (the placeholder or no chip records chip: null) and headSocket { state } is the /_head/ws socket ('open' only after
 * a frame crossed a live socket). Wave 4G Lane E3: headSocket now resolves two witnesses, the page sockets the browser
 * reported (headSocket.page) and her worker runtime's own count of its socket from GET /__x6__/status
 * (headSocket.runtime, webworker-runtime src/x6/head-socket-telemetry.ts), because Playwright never reports a dedicated
 * worker's frames. Either witness proving 'open' with frames > 0 makes it 'open'. observe-verdict.mjs fails
 * WORKSPACE_NOT_AUMA and HEAD_SOCKET_NOT_OPEN on anything else, including an 'open' claim with no frame-backed witness.
 *
 * Usage:  X61_OWNER_JWT=… X61_PLAYWRIGHT_DIR=<abs dir outside the checkout> [X61_EXPECT_BUILD_SHA=<40-hex>]
 *           node deploy/ci/observe-fresh-x61.mjs [--turn] [--out report.json]
 *   --turn  context A sends a short marker turn through the composer (spends ONE model call per engine); context B must
 *           find it in history restored from cloud state with zero model requests. Off by default.
 * Exit:   0 PASS · 1 FAIL · 2 UNPERFORMED (owner credential missing or malformed, an unsafe debug setting, or no
 *         pinned Playwright outside the checkout).
 *
 * CREDENTIAL HANDLING. The owner EdDSA JWT is read only from env X61_OWNER_JWT. It is never printed, logged, written or
 * screenshotted: it is passed once per context into the page and posted from there to POST /_auth/owner, exactly as the
 * product's own sign-in page does (deploy/cloudflare/src/worker.mjs:147-151), so Origin and Sec-Fetch-Site are the
 * browser's own same-origin values (worker.mjs:436-441). The endpoint sets the HttpOnly CF_Authorization cookie
 * (worker.mjs:448-452); the observer then checks only that the cookie exists, never its value. Every line of output is
 * passed through redact() as a second line of defence. The origin is a fixed constant, never taken from the environment.
 * This file lives under deploy/ (T2, deploy/cloudflare/src/cloud-brokers.mjs isT2ProtectedRepoPath) because the job that
 * runs it holds the owner credential.
 */
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verdict, ENGINES, CONTEXTS, DEFAULT_ALLOWLIST } from './observe-verdict.mjs'

const ORIGIN = 'https://node.example.invalid'
const SHA40 = /^[0-9a-f]{40}$/
const VIEWPORT = { width: 1440, height: 900 }
const BOOT_TIMEOUT_MS = 120_000
const IDLE_TIMEOUT_MS = 90_000
const FACTS_ATTEMPTS = 4
const FACTS_RETRY_MS = 3000
const HEAD_SOCKET_TIMEOUT_MS = 30_000
const WORKSPACE_TIMEOUT_MS = 30_000
/** Exact Playwright release this observer runs against. The CI job installs it from integrity-pinned registry tarballs
 * into a directory outside the checkout and names that directory in X61_PLAYWRIGHT_DIR. */
const PLAYWRIGHT_VERSION = '1.61.1'
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

// ---- capture helpers --------------------------------------------------------------------------------------------------
// Pure: no I/O, no clock, no imports. observe-fresh-x61.test.mjs loads exactly the text between the two markers, so the
// facts the verdict judges (workspace.chip, headSocket.state) are produced by tested code, not by an untested inline.
// <capture-helpers>
/** The head socket (deploy/cloudflare/src/worker.mjs:674 forwards it to HEAD; head-do.mjs:1635-1641 accepts it and greets
 * every new socket with the current head as one 'ball:commit' frame). Opened by her worker (webworker-runtime
 * src/x6/ball-loader.ts:3039) and by the page's live hub (ui-layout spatial/work/autonomy.ts:335). */
export const HEAD_SOCKET_PATH = '/_head/ws'
/** The workspace chip's accessible name in en-US, which is also its placeholder text when no workspace is picked
 * (ui-conversation/src/client/skeleton/EmptyHero.tsx WorkspaceChip; ui-conversation/src/client/locales.ts:471). */
export const WORKSPACE_CHIP_LABEL = 'Choose workspace'

/**
 * The chip as the verdict reads it (observe-verdict.mjs WORKSPACE_NOT_AUMA). Whitespace is collapsed; the placeholder,
 * an empty label or a missing chip are all chip: null, so none of them can pass.
 * @param {unknown} raw The chip's label text, or null when no chip was found.
 * @returns {{ chip: string|null, placeholder: boolean, present: boolean }}
 */
export function chipFromText(raw) {
  if (typeof raw !== 'string') return { chip: null, placeholder: false, present: false }
  const label = raw.replace(/\s+/g, ' ').trim()
  if (label === '') return { chip: null, placeholder: false, present: true }
  if (label === WORKSPACE_CHIP_LABEL) return { chip: null, placeholder: true, present: true }
  return { chip: label.slice(0, 120), placeholder: false, present: true }
}

/**
 * The head socket's state from the WebSocket rows the browser reported (observe-verdict.mjs HEAD_SOCKET_NOT_OPEN).
 * 'open' needs a /_head/ws socket that is not closed and has carried at least one frame: HEAD greets every accepted socket
 * and a browser refuses send() before open, so a frame proves the handshake completed. A socket that never carried a
 * frame is 'connecting'; if every one closed, 'closed'; if none was ever opened, 'absent'. Only 'open' passes.
 * Measured with Playwright 1.61.1 in Chromium, Firefox and WebKit: a socket opened by a dedicated worker (her runtime's)
 * is reported without any of its frames (and WebKit never reports its close), so from the page only a page socket (the
 * live hub) can prove 'open'; worker sockets show up as `silent`, never as open. The worker's own report covers them
 * (runtimeHeadSocket / resolveHeadSocket below).
 * @param {unknown} sockets Rows of { path, closed, framesReceived, framesSent, errors }.
 * @returns {{ state: 'open'|'connecting'|'closed'|'absent', sockets: number, open: number, closed: number, errors: number }}
 */
export function headSocketState(sockets) {
  const rows = (Array.isArray(sockets) ? sockets : []).filter((row) => row && typeof row === 'object' && row.path === HEAD_SOCKET_PATH)
  const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)
  const live = rows.filter((row) => row.closed !== true)
  const open = live.filter((row) => count(row.framesReceived) + count(row.framesSent) > 0)
  const state = rows.length === 0 ? 'absent' : open.length > 0 ? 'open' : live.length > 0 ? 'connecting' : 'closed'
  return { state, sockets: rows.length, open: open.length, silent: live.length - open.length, closed: rows.length - live.length,
    errors: rows.reduce((total, row) => total + count(row.errors), 0) }
}

/** The states the runtime may report (webworker-runtime src/x6/head-socket-telemetry.ts). */
export const RUNTIME_SOCKET_STATES = Object.freeze(['open', 'connecting', 'closed', 'absent'])

/**
 * Her worker's own head-socket report (GET /__x6__/status headSocket), re-judged here rather than trusted: 'open' stays
 * 'open' only with framesReceived + framesSent > 0 (an open claim with zero frames becomes 'connecting'); an unknown or
 * missing state, or a missing report, is 'absent'. Counters that are not non-negative safe integers count as zero.
 * @param {unknown} raw The status body's headSocket field, as read in the page.
 * @returns {{ state: 'open'|'connecting'|'closed'|'absent', framesReceived: number, framesSent: number, errors: number, reconnects: number, reported: boolean }}
 */
export function runtimeHeadSocket(raw) {
  const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { state: 'absent', framesReceived: 0, framesSent: 0, errors: 0, reconnects: 0, reported: false }
  }
  const framesReceived = count(raw.framesReceived), framesSent = count(raw.framesSent)
  const claimed = RUNTIME_SOCKET_STATES.includes(raw.state) ? raw.state : 'absent'
  const state = claimed === 'open' && framesReceived + framesSent === 0 ? 'connecting' : claimed
  return { state, framesReceived, framesSent, errors: count(raw.errors), reconnects: count(raw.reconnects), reported: true }
}

/**
 * The context's head socket from both witnesses: 'open' when the page capture (headSocketState) proves an open socket
 * that carried a frame, or the runtime report (runtimeHeadSocket) does. Otherwise the more informative non-open state
 * (the runtime's when it reported, else the page's). `source` names which witness proved 'open' (null when none did).
 * @param {ReturnType<typeof headSocketState>} page
 * @param {ReturnType<typeof runtimeHeadSocket>} runtime
 * @returns {{ state: string, source: 'page'|'runtime'|'page+runtime'|null, page: object, runtime: object }}
 */
export function resolveHeadSocket(page, runtime) {
  const pageOpen = page?.state === 'open' && Number.isSafeInteger(page.open) && page.open > 0
  const runtimeOpen = runtime?.state === 'open' && (runtime.framesReceived + runtime.framesSent) > 0
  const source = pageOpen && runtimeOpen ? 'page+runtime' : pageOpen ? 'page' : runtimeOpen ? 'runtime' : null
  const state = source !== null ? 'open' : runtime?.reported ? runtime.state : (page?.state ?? 'absent')
  return { state, source, page, runtime }
}
// </capture-helpers>

// ---- arguments and credential --------------------------------------------------------------------------------------
const args = process.argv.slice(2)
// --check-playwright (alone) only verifies the pinned Playwright install and exits; it reads no credential and opens no
// browser, so the workflow can run it in the install step, before any secret is in the environment.
const CHECK_ONLY = args.length === 1 && args[0] === '--check-playwright'
const TURN = args.includes('--turn')
const outIndex = args.indexOf('--out')
const OUT = outIndex >= 0 ? args[outIndex + 1] : null
// An unknown argument is refused without echoing it: a misplaced credential must not reach the log.
if (!CHECK_ONLY && ((outIndex >= 0 && (!OUT || OUT.startsWith('--'))) || args.some((arg) => !['--turn', '--out'].includes(arg) && arg !== OUT))) {
  console.error(JSON.stringify({ code: 'OBSERVER_ARGUMENT_INVALID', verdict: 'UNPERFORMED', usage: '[--turn] [--out <report.json>] | --check-playwright' }))
  process.exit(2)
}

const unperformed = (code, note) => {
  console.error(JSON.stringify({ code, verdict: 'UNPERFORMED', note }))
  process.exit(2)
}
if (CHECK_ONLY) {
  const playwright = loadPinnedPlaywright()
  const launchers = ['chromium', 'firefox', 'webkit'].every((name) => typeof playwright[name]?.launch === 'function')
  if (!launchers) unperformed('PLAYWRIGHT_UNPINNED', 'The pinned Playwright does not expose all three browser launchers.')
  console.log(JSON.stringify({ code: 'PLAYWRIGHT_PINNED', version: PLAYWRIGHT_VERSION, launchers: ['chromium', 'firefox', 'webkit'] }))
  process.exit(0)
}
const JWT = process.env.X61_OWNER_JWT
if (!JWT) unperformed('OWNER_CREDENTIAL_MISSING', 'X61_OWNER_JWT is not set. No browser was opened; this run is UNPERFORMED, not green.')
if (JWT.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(JWT)) {
  unperformed('OWNER_CREDENTIAL_MALFORMED', 'X61_OWNER_JWT is not a compact JWS. No browser was opened; this run is UNPERFORMED.')
}
// Playwright's protocol logger prints evaluate() arguments, which would include the credential.
if (/pw:|\*/.test(process.env.DEBUG ?? '') || process.env.PWDEBUG) {
  unperformed('OBSERVER_DEBUG_REFUSED', 'DEBUG/PWDEBUG would log protocol traffic containing the credential. Unset them.')
}
const EXPECTED_SHA = (process.env.X61_EXPECT_BUILD_SHA ?? '').toLowerCase() || null
if (EXPECTED_SHA && !SHA40.test(EXPECTED_SHA)) unperformed('EXPECTED_SHA_INVALID', 'X61_EXPECT_BUILD_SHA must be a 40-hex commit SHA.')

// Playwright is loaded ONLY from a directory outside the repository checkout. Everything a workspace install would use
// (package.json files, pnpm-lock.yaml, pnpm-workspace.yaml, .pnpmfile.cjs, node_modules) is T1-writable, and this
// process holds the owner credential, so it must never execute code from that tree. The directory is set by the
// workflow (.github/, T2), filled from integrity-pinned tarballs, and both packages must resolve inside it at the exact
// pinned version; anything else is UNPERFORMED, never a fallback to the workspace copy.
function loadPinnedPlaywright() {
  const dir = process.env.X61_PLAYWRIGHT_DIR ?? ''
  if (!dir || !isAbsolute(dir)) unperformed('PLAYWRIGHT_DIR_MISSING', 'X61_PLAYWRIGHT_DIR must be an absolute directory holding the pinned Playwright. No browser was opened.')
  let root, repo
  try { root = realpathSync(dir); repo = realpathSync(REPO_ROOT) } catch { unperformed('PLAYWRIGHT_UNAVAILABLE', 'X61_PLAYWRIGHT_DIR does not exist. No browser was opened.') }
  if (root === repo || root.startsWith(repo + sep) || repo.startsWith(root + sep)) {
    unperformed('PLAYWRIGHT_DIR_IN_REPO', 'X61_PLAYWRIGHT_DIR overlaps the repository checkout, whose dependency tree is T1-writable. No browser was opened.')
  }
  const expect = (name) => join(root, 'node_modules', name, 'package.json')
  const pinned = (file, name) => {
    try {
      if (realpathSync(file) !== expect(name)) return false
      const meta = JSON.parse(readFileSync(file, 'utf8'))
      return meta.name === name && meta.version === PLAYWRIGHT_VERSION
    } catch { return false }
  }
  const fromRoot = createRequire(join(root, 'noop.js'))
  let playwrightMeta = null, coreMeta = null
  try {
    playwrightMeta = fromRoot.resolve('playwright/package.json')
    coreMeta = createRequire(playwrightMeta).resolve('playwright-core/package.json')
  } catch { /* judged below */ }
  if (!playwrightMeta || !coreMeta || !pinned(playwrightMeta, 'playwright') || !pinned(coreMeta, 'playwright-core')) {
    unperformed('PLAYWRIGHT_UNPINNED', `playwright and playwright-core ${PLAYWRIGHT_VERSION} must both resolve inside X61_PLAYWRIGHT_DIR/node_modules. No browser was opened.`)
  }
  return fromRoot('playwright')
}
const { chromium, firefox, webkit } = loadPinnedPlaywright()
const BROWSERS = { chromium, firefox, webkit }

// ---- redaction ------------------------------------------------------------------------------------------------------
const jwtParts = JWT.split('.').filter((part) => part.length >= 12)
function redact(value, limit = 500) {
  let text = String(value ?? '')
  text = text.replaceAll(JWT, '[redacted]')
  for (const part of jwtParts) text = text.replaceAll(part, '[redacted]')
  return text
    .replace(/CF_Authorization=[^;\s"'<>]+/gi, 'CF_Authorization=[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '[redacted jwt]')
    .replace(/\b(?:Basic|Bearer)\s+[^\s"']+/gi, '[redacted authorization]')
    .replace(/([?&](?:ticket|token|key|jwt|assertion)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-|ghp_|github_pat_|xai-)[A-Za-z0-9_-]{8,}/g, '[redacted key]')
    .slice(0, limit)
}
const emit = (record) => { console.log(redact(JSON.stringify(record), 200_000)) }

/** Same-origin path only; a query string is dropped because it can carry a ticket. Foreign hosts keep their host. */
function safePath(raw) {
  try {
    const url = new URL(raw)
    return url.origin === ORIGIN ? url.pathname : `${url.protocol}//${url.host}${url.pathname}`.slice(0, 200)
  } catch { return '[unparsable url]' }
}

// ---- page-side helpers (run in the page; they read only DOM and same-origin JSON) -----------------------------------
const PROBE_HEADER = 'x-aukora-observer'

/** GET a same-origin JSON route from inside the page, so the session cookie applies. The marker header keeps these
 * probe requests out of the app's own failure counters; the probe result is judged on its own. */
async function probe(page, path) {
  return page.evaluate(async ({ path, header }) => {
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { [header]: '1' } })
      let body = null
      try { body = await response.json() } catch { body = null }
      return { status: response.status, body }
    } catch { return { status: -1, body: null } }
  }, { path, header: PROBE_HEADER })
}

/** Runtime status through the in-page worker tunnel (webworker-runtime/src/client/index.ts:160; tunnel.ts:429;
 * worker-host.ts:347-350; ball-loader.ts:5085-5089 → readStatus ball-loader.ts:3155-3183). Only named fields leave. */
async function readRuntime(page) {
  return page.evaluate(async () => {
    const transport = globalThis.__DSH_TRANSPORT__
    if (typeof transport?.fetch !== 'function') return { available: false, reason: 'TRANSPORT_ABSENT' }
    let timer
    try {
      const response = await Promise.race([
        transport.fetch('/__x6__/status'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000) }),
      ])
      if (!response.ok) return { available: false, reason: `RUNTIME_STATUS_HTTP_${response.status}` }
      const s = await response.json()
      const p = s?.persistence, l = p?.localSave, m = p?.mirror
      const mutation = s?.mutation && typeof s.mutation === 'object' ? {
        ballId: typeof s.mutation.ballId === 'string' ? s.mutation.ballId : null,
        prepared: s.mutation.prepared === true, activated: s.mutation.activated === true,
        localSaved: s.mutation.localSaved === true, remoteSaved: s.mutation.remoteSaved === true,
        receiptSaved: s.mutation.receiptSaved === true,
      } : null
      return {
        available: s?.ok === true && p !== null && typeof p === 'object',
        ballId: typeof s?.ballId === 'string' ? s.ballId : null,
        epoch: Number.isSafeInteger(s?.epoch) ? s.epoch : null,
        buildSha: typeof s?.buildSha === 'string' ? s.buildSha : null,
        // idb-persist.ts:377-414
        persistence: {
          durable: p?.durable === true, readOnly: p?.readOnly === true, conflict: p?.conflict ?? null,
          localError: l?.error ?? null, localPendingPaths: Number.isSafeInteger(l?.pendingPaths) ? l.pendingPaths : null,
          target: typeof m?.target === 'string' ? m.target : null, sending: m?.sending === true,
          pendingBatches: Number.isSafeInteger(m?.pendingBatches) ? m.pendingBatches : null,
          pendingBytes: Number.isSafeInteger(m?.pendingBytes) ? m.pendingBytes : null,
          mirrorConflict: m?.conflict ?? null, mirrorError: m?.error ?? null,
          reconciliationRequired: m?.reconciliationRequired === true, resyncPending: m?.resyncPending === true,
          transient: m?.transient ?? null,
          quarantinedPaths: Array.isArray(m?.quarantinedPaths) ? m.quarantinedPaths.slice(0, 50).map(String) : null,
          deferredJournals: Array.isArray(m?.deferredJournals) ? m.deferredJournals.length : null,
          shadowedJournals: Array.isArray(m?.shadowedJournals) ? m.shadowedJournals.length : null,
          lastAcknowledgedAt: Number.isFinite(m?.lastAcknowledgedAt) ? m.lastAcknowledgedAt : null,
        },
        mutation,
        // Lane E3: her worker's own /_head/ws report (ball-loader.ts readStatus headSocket); judged in Node by runtimeHeadSocket.
        headSocket: s?.headSocket && typeof s.headSocket === 'object' ? {
          state: typeof s.headSocket.state === 'string' ? s.headSocket.state.slice(0, 20) : null,
          framesReceived: s.headSocket.framesReceived, framesSent: s.headSocket.framesSent,
          errors: s.headSocket.errors, reconnects: s.headSocket.reconnects,
        } : null,
        // RunningStatus.tsx:37 renders [data-chat-running] while a turn is open.
        turnClosed: document.querySelector('[data-chat-running]') === null,
      }
    } catch { return { available: false, reason: 'RUNTIME_STATUS_FAILED' } } finally { clearTimeout(timer) }
  })
}

const settledPersistence = (r) => {
  const p = r?.persistence
  return r?.available === true && r.turnClosed && p.durable && !p.readOnly && p.conflict === null && p.localError === null
    && p.localPendingPaths === 0 && p.target !== null && !p.sending && p.pendingBatches === 0 && p.pendingBytes === 0
    && p.mirrorConflict === null && p.mirrorError === null && !p.reconciliationRequired && !p.resyncPending
    && p.transient === null && p.deferredJournals === 0
}

/** Wait until the runtime reports nothing pending and no tracked POST is in flight for one quiet second. A conflict is
 * never retried or overwritten by the observer. */
async function waitForDurableIdle(page, work, timeoutMs = IDLE_TIMEOUT_MS) {
  const started = Date.now()
  let quietSince = null
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await readRuntime(page)
    const network = work()
    if (settledPersistence(last) && network.pending === 0) quietSince ??= Date.now()
    else quietSince = null
    if (quietSince !== null && Date.now() - Math.max(quietSince, network.changedAt) >= 1000) return { ...last, idle: true }
    if (last?.persistence?.conflict || last?.persistence?.mirrorConflict || last?.persistence?.reconciliationRequired) break
    await page.waitForTimeout(250)
  }
  return { ...(last ?? { available: false, reason: 'RUNTIME_STATUS_NEVER_READ' }), idle: false }
}

// ---- workspace chip and head socket (Wave 4E Lane E2) ------------------------------------------------------------------
/** The chip's label text from the page, or null when no chip is rendered. A visible chip wins over a hidden one. Ported
 * from X63 observe-fresh.mjs waitForChip; the label is the chip's last non-empty span (EmptyHero.tsx: icon, label, chevron). */
async function readChipText(page) {
  return page.evaluate((label) => {
    const chips = [...document.querySelectorAll(`[aria-label="${label}"]`)]
    const chip = chips.find((node) => node.getClientRects().length > 0) ?? chips[0]
    if (!chip) return null
    const spans = [...chip.querySelectorAll('span')].map((span) => (span.textContent ?? '').trim()).filter(Boolean)
    return spans.length ? spans[spans.length - 1] : (chip.textContent ?? '')
  }, WORKSPACE_CHIP_LABEL).catch(() => null)
}

/** Wait (bounded) for the chip to name a workspace; a cold start legitimately shows the placeholder for a moment. */
async function readWorkspace(page, timeoutMs = WORKSPACE_TIMEOUT_MS) {
  const started = Date.now()
  let seen = chipFromText(await readChipText(page))
  while (seen.chip === null && Date.now() - started < timeoutMs) {
    await page.waitForTimeout(250)
    seen = chipFromText(await readChipText(page))
  }
  return { ...seen, waitedMs: Date.now() - started }
}

/** Both witnesses of the head socket right now: the browser's page sockets and her worker's own status report. */
async function observeHeadSocket(page, sockets) {
  const runtime = await readRuntime(page).catch(() => null)
  return resolveHeadSocket(headSocketState(sockets), runtimeHeadSocket(runtime?.headSocket))
}

/** Wait (bounded) until either witness proves the /_head/ws socket open. */
async function readHeadSocket(page, sockets, timeoutMs = HEAD_SOCKET_TIMEOUT_MS) {
  const started = Date.now()
  let seen = await observeHeadSocket(page, sockets)
  while (seen.state !== 'open' && Date.now() - started < timeoutMs) {
    await page.waitForTimeout(250)
    seen = await observeHeadSocket(page, sockets)
  }
  return { ...seen, waitedMs: Date.now() - started }
}

// ---- the five protected Spatial surfaces, through their real launchers --------------------------------------------
// Tabs: AppFrame.tsx:96 (MENU_TABS) and :541 (button[role=tab][data-menu-tab]); stack: AppFrame.tsx:564 [data-menu-stack];
// launchers: portal/menus.tsx:31-32,71-73 (ids) and :52 (data-launcher), settings :84 and :105 (data-settings-section);
// active surface: AppFrame.tsx:500 [data-surface-active].
const SURFACES = Object.freeze([
  { id: 'messages', tab: 'apps', launcher: '[data-menu-stack] button[data-launcher="messages"]',
    marker: '[data-nostr-messages]', needle: 'Nostr Messages' }, // NostrMessagesSurface.tsx:41,469-470
  { id: 'media', tab: 'apps', launcher: '[data-menu-stack] button[data-launcher="media"]',
    marker: '[data-media-studio]', needle: 'Media' }, // MediaSurface.tsx:26,131; apps/media/locales.ts:16
  { id: 'identity', tab: 'system', launcher: '[data-menu-stack] button[data-launcher="identity"]',
    marker: '[data-identity-surface]', needle: 'Identity' }, // IdentitySurface.tsx:36,312
  { id: 'aumlok', tab: 'system', launcher: '[data-menu-stack] button[data-launcher="aumlok"]',
    marker: '[data-aumlok-surface]', needle: 'AUMLOK' }, // AumlokSurface.tsx:446,800,810; aumlok/locales.ts:66
  { id: 'settings', tab: 'system', launcher: '[data-menu-stack] button[data-settings-section="general"]',
    marker: 'section[data-settings-section="general"]', needle: 'General' }, // x5/SettingsSurfaces.tsx:20,54; x5/general.tsx:98
])

async function clickControl(page, selector) {
  const control = page.locator(selector).first()
  await control.click({ timeout: 15000 }).catch(() => control.click({ timeout: 15000, force: true }))
}

async function openSurface(page, spec) {
  try {
    await clickControl(page, `button[role="tab"][data-menu-tab="${spec.tab}"]`)
    await clickControl(page, spec.launcher)
    await page.waitForFunction((id) => document.querySelector('[data-surface-active]')?.getAttribute('data-surface-active') === id,
      spec.id, { timeout: 20000 })
  } catch (error) {
    const active = await page.evaluate(() => document.querySelector('[data-surface-active]')?.getAttribute('data-surface-active') ?? null).catch(() => null)
    return { id: spec.id, reachable: false, active, error: redact(String(error?.message ?? error).split('\n')[0], 160) }
  }
  return page.evaluate((spec) => {
    const stack = document.querySelector('[data-surface-active]')
    const node = stack?.querySelector(spec.marker) ?? null
    const text = node?.textContent ?? ''
    const shown = Boolean(node) && node.getClientRects().length > 0 && node.closest('[hidden]') === null
    const placeholder = /placeholder shell|coming soon|not yet implemented/i.test(text)
    return { id: spec.id, active: stack?.getAttribute('data-surface-active') ?? null, shown, placeholder,
      reachable: shown && text.includes(spec.needle) && !placeholder }
  }, spec)
}

// ---- marker turn (opt-in), ported from X63 fresh-window-ui.mjs with selectors re-verified on x6.1 --------------------
// New chat: spatial/portal/ThreadsLane.tsx:483; composer: ui-conversation/.../ComposerContentEditable.tsx:46;
// Send message: ui-conversation/src/client/locales.ts:420 via InputBar.tsx:376; rows: ThreadsLane.tsx:517-518;
// turns: ui-chat ChatNodeSeat.tsx:160-162, UserContent.tsx:47, ReasoningRow.tsx:89.
async function sendMarker(page, prompt) {
  const composer = page.locator('[data-composer-input][contenteditable="true"]:visible').last()
  if (!await composer.isVisible()) await page.getByRole('button', { name: 'New chat', exact: true }).click({ timeout: 90000 })
  await composer.waitFor({ state: 'visible', timeout: 90000 })
  await composer.click()
  await page.keyboard.type(prompt, { delay: 1 })
  if ((await composer.innerText()).trim() !== prompt) return false
  await page.getByRole('button', { name: 'Send message', exact: true }).click({ timeout: 30000 })
  return true
}

function hasMarkerTurn({ prompt, reply }) {
  const user = [...document.querySelectorAll('[data-chat-flow-kind="user"] [data-message-bubble]')]
    .find((bubble) => bubble.getClientRects().length && bubble.textContent.trim() === prompt)
  const turn = user?.closest('[data-chat-turn]')?.getAttribute('data-chat-turn')
  if (!turn) return false
  for (const row of document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')) {
    if (row.getAttribute('data-chat-turn') !== turn || row.getAttribute('data-chat-group-part') === 'reasoning') continue
    for (const text of row.querySelectorAll('[data-text-interaction-source]')) {
      if (text.getClientRects().length && !text.closest('[data-variant="think"]') && text.textContent.trim() === reply) return true
    }
  }
  return false
}

async function openRestoredThread(page, threadId) {
  await page.waitForFunction((id) => [...document.querySelectorAll('[data-thread-id]')]
    .some((row) => row.getAttribute('data-thread-id') === id && row.getClientRects().length), threadId, { timeout: 90000, polling: 250 })
  const rows = page.locator('[data-thread-id]')
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index)
    if (await row.getAttribute('data-thread-id') === threadId) { await row.locator('button').first().click(); return true }
  }
  return false
}

// ---- one fresh context ----------------------------------------------------------------------------------------------
async function signIn(context, page) {
  // An unsigned document request receives the owner sign-in page with status 401 (worker.mjs:193-209,455).
  const first = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  if (first?.status() !== 401) return { ok: false, code: `SIGNIN_PAGE_UNEXPECTED_${first?.status() ?? 'NONE'}` }
  // The same request the product's sign-in page makes (worker.mjs:147-151). Errors are reduced to a status number:
  // nothing thrown here can carry the argument back out.
  const status = await page.evaluate(async (token) => {
    try {
      const response = await fetch('/_auth/owner', { method: 'POST', headers: { 'content-type': 'application/jwt' },
        credentials: 'same-origin', redirect: 'error', cache: 'no-store', body: token })
      return response.status
    } catch { return -1 }
  }, JWT).catch(() => -2)
  if (status !== 200) return { ok: false, code: `OWNER_SIGNIN_REFUSED_${status}` }
  const cookie = (await context.cookies(ORIGIN)).some((c) => c.name === 'CF_Authorization' && c.httpOnly && c.secure)
  return cookie ? { ok: true } : { ok: false, code: 'OWNER_SESSION_COOKIE_MISSING' }
}

async function observeContext(browser, engine, label, shared) {
  const record = { engine, context: label, signedIn: false, appReady: false, consoleErrors: [], consoleWarnings: 0,
    failedRequests: [], httpErrors: [], surfaces: [], model: { posts: 0, reads: 0 } }
  // No storageState: a brand-new context has no cookies, localStorage or IndexedDB from any earlier window.
  const context = await browser.newContext({ locale: 'en-US', viewport: VIEWPORT })
  let frozen = false
  try {
    const page = await context.newPage()
    const signed = await signIn(context, page)
    if (!signed.ok) { record.fatal = signed.code; return record }
    record.signedIn = true

    // Collectors start now, so the measured window is the authenticated cold boot only.
    const pending = new Set()
    let changedAt = Date.now()
    const isProbe = (request) => { try { return request.headers()[PROBE_HEADER] === '1' } catch { return false } }
    const tracked = (request) => {
      const path = safePath(request.url())
      return request.method() === 'POST' && (path.startsWith('/door/') || path === '/_mirror/delta')
    }
    context.on('request', (request) => {
      if (frozen) return
      const path = safePath(request.url())
      // Provider doors: worker.mjs:364,525 (/door/<provider>/...). A POST there is a model request.
      if (path.startsWith('/door/')) { if (request.method() === 'POST') record.model.posts += 1; else record.model.reads += 1 }
      if (tracked(request)) { pending.add(request); changedAt = Date.now() }
    })
    const finished = (request) => { if (pending.delete(request)) changedAt = Date.now() }
    context.on('requestfinished', finished)
    context.on('requestfailed', (request) => {
      finished(request)
      if (frozen || isProbe(request)) return
      record.failedRequests.push({ method: request.method(), path: safePath(request.url()), failure: redact(request.failure()?.errorText ?? 'failed', 120) })
    })
    context.on('response', (response) => {
      if (frozen || response.status() < 400 || isProbe(response.request())) return
      record.httpErrors.push({ method: response.request().method(), path: safePath(response.url()), status: response.status() })
    })
    page.on('console', (message) => {
      if (frozen) return
      if (message.type() === 'error') record.consoleErrors.push(redact(message.text(), 300))
      else if (message.type() === 'warning') record.consoleWarnings += 1
    })
    page.on('pageerror', (error) => { if (!frozen) record.consoleErrors.push(`pageerror: ${redact(error?.message ?? error, 300)}`) })
    // WebSockets as the browser itself reports them (Playwright 'websocket'). Only counts are kept: frame payloads are never
    // read or stored (a head greeting carries every module's code), and the URL keeps its path only (safePath drops the
    // query, which carries peer and ball ids).
    const sockets = []
    page.on('websocket', (socket) => {
      const row = { path: safePath(socket.url()), closed: false, framesReceived: 0, framesSent: 0, errors: 0 }
      sockets.push(row)
      socket.on('framereceived', () => { row.framesReceived += 1 })
      socket.on('framesent', () => { row.framesSent += 1 })
      socket.on('socketerror', () => { row.errors += 1 })
      socket.on('close', () => { row.closed = true })
    })
    const work = () => ({ pending: pending.size, changedAt })

    const boot = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    record.documentStatus = boot?.status() ?? null
    // The real Spatial frame: menu tabs (AppFrame.tsx:541), the menu stack (:564), the surface stack (:500) and the
    // worker transport (webworker-runtime/src/client/index.ts:160). ui-workspace/src/client/locales.ts:135 is the
    // default-workspace failure text.
    const ready = await page.waitForFunction(() => {
      if ((document.body?.innerText ?? '').includes('Unable to create default workspace')) return 'workspace-failed'
      return typeof globalThis.__DSH_TRANSPORT__?.fetch === 'function'
        && document.querySelector('button[role="tab"][data-menu-tab="apps"]') !== null
        && document.querySelector('[data-menu-stack]') !== null
        && document.querySelector('[data-surface-active], [data-surface-empty]') !== null ? 'ready' : false
    }, null, { timeout: BOOT_TIMEOUT_MS, polling: 250 }).then((handle) => handle.jsonValue()).catch(() => 'timeout')
    record.title = await page.title().catch(() => null)
    if (ready !== 'ready') { record.fatal = ready === 'workspace-failed' ? 'DEFAULT_WORKSPACE_FAILED' : 'SPATIAL_BOOT_TIMEOUT'; return record }
    record.appReady = true
    // Live facts the verdict judges per context: the head socket must be open and the chip must read 'auma'.
    record.headSocket = await readHeadSocket(page, sockets)
    record.workspace = await readWorkspace(page)

    // Edge facts, read with the session cookie from inside the page.
    const health = await probe(page, '/api/health') // worker.mjs:509
    record.health = { status: health.status, ok: health.body?.ok === true, ready: health.body?.ready === true,
      buildSha: typeof health.body?.buildSha === 'string' ? health.body.buildSha : null }
    const head = await probe(page, '/__x6/status') // worker.mjs:457,513; head-do.mjs:1293-1298
    record.head = { status: head.status, ballId: head.body?.head?.ballId ?? null, epoch: head.body?.head?.epoch ?? null }
    // worker.mjs:458,513; head-do.mjs:1284-1291; verified-facts.mjs:393-417. An incomplete snapshot answers 503 with no
    // reason code. Some causes are transient (AURA_SNAPSHOT_CHANGED mirror-do.mjs:853,939; AURA_HEAD_CHANGED and
    // AURA_SNAPSHOT_CHANGED head-do.mjs:850,853; AURA_TIMEOUT head-do.mjs:874), others are a broken ledger
    // (AURA_CHECKPOINT_INVALID). A bounded retry absorbs the first kind; whatever is still incomplete FAILS the verdict.
    let facts = { status: -1, body: null }
    let attempts = 0
    while (attempts < FACTS_ATTEMPTS) {
      attempts += 1
      facts = await probe(page, '/__x6/facts')
      if (facts.status === 200 && facts.body?.ok === true) break
      if (attempts < FACTS_ATTEMPTS) await page.waitForTimeout(FACTS_RETRY_MS)
    }
    const f = facts.body ?? {}
    record.facts = { status: facts.status, ok: f.ok === true, attempts, epoch: f.epoch ?? null, ballId: f.ballId ?? null,
      receiptTotal: f.receiptTotal ?? null, receiptsVerified: f.receiptsVerified ?? null,
      checkpointsTotal: f.checkpointsTotal ?? null, lastCheckpointSeq: f.lastCheckpointSeq ?? null,
      lastCheckpointReceiptCount: f.lastCheckpointReceiptCount ?? null,
      checkpointVerification: f.checkpointVerification ?? null, checkpointSignerTrust: f.checkpointSignerTrust ?? null,
      // Not part of the projection today (verified-facts.mjs:398-416); carried only if a future build adds it.
      ...(typeof f.merkleRoot === 'string' ? { merkleRoot: f.merkleRoot } : {}) }

    if (TURN && label === 'A') {
      const marker = `x61m${Date.now().toString(36)}${engine.slice(0, 2)}`
      const prompt = `${marker} Reply with the single word PONG. Do not use tools.`
      const turn = { marker, typed: false, markerHere: false, settled: false, threadId: null }
      record.turn = turn
      turn.typed = await sendMarker(page, prompt).catch(() => false)
      if (turn.typed) {
        turn.markerHere = await page.waitForFunction(hasMarkerTurn, { prompt, reply: 'PONG' }, { timeout: 180000, polling: 250 })
          .then(() => true).catch(() => false)
        turn.threadId = await page.locator('[data-thread-id][data-current="true"]').first().getAttribute('data-thread-id', { timeout: 10000 }).catch(() => null)
        turn.settled = (await waitForDurableIdle(page, work)).idle === true
      }
      shared.prompt = prompt
      shared.threadId = turn.threadId
      shared.ready = turn.markerHere && turn.settled && Boolean(turn.threadId)
    }
    if (TURN && label === 'B') {
      const turn = { markerThere: false, modelRequests: null }
      record.turn = turn
      if (shared.ready) {
        if (await openRestoredThread(page, shared.threadId).catch(() => false)) {
          turn.markerThere = await page.waitForFunction(hasMarkerTurn, { prompt: shared.prompt, reply: 'PONG' }, { timeout: 90000, polling: 250 })
            .then(() => true).catch(() => false)
        }
      }
    }

    for (const spec of SURFACES) record.surfaces.push(await openSurface(page, spec))

    // Final persistence state after everything this window did.
    record.runtime = await waitForDurableIdle(page, work)
    if (record.turn && label === 'B') record.turn.modelRequests = record.model.posts
    // For the record only (the verdict judges the boot-time state above): did the socket stay open through the surfaces?
    if (record.headSocket) record.headSocket.finalState = (await observeHeadSocket(page, sockets)).state
  } catch (error) {
    record.fatal ??= `OBSERVER_ERROR: ${redact(String(error?.message ?? error).split('\n')[0], 200)}`
  } finally {
    // Closing aborts in-flight requests; those aborts are the observer's, not the app's.
    frozen = true
    await context.close().catch(() => {})
  }
  return record
}

// ---- release wait (from X63 wait-release.mjs): three consecutive matching buildSha reads -----------------------------
async function waitRelease(browser) {
  if (!EXPECTED_SHA) return { skipped: true }
  const context = await browser.newContext({ locale: 'en-US', viewport: VIEWPORT })
  try {
    const page = await context.newPage()
    const signed = await signIn(context, page)
    if (!signed.ok) return { ok: false, code: signed.code }
    const deadline = Date.now() + 180_000
    let matches = 0
    let last = null
    while (Date.now() < deadline) {
      const health = await probe(page, '/api/health')
      last = typeof health.body?.buildSha === 'string' ? health.body.buildSha.toLowerCase() : null
      matches = health.status === 200 && health.body?.ready === true && last === EXPECTED_SHA ? matches + 1 : 0
      if (matches === 3) return { ok: true, buildSha: last }
      await page.waitForTimeout(2000)
    }
    return { ok: false, code: 'RELEASE_WAIT_TIMEOUT', lastBuildSha: last }
  } finally { await context.close().catch(() => {}) }
}

// ---- main -------------------------------------------------------------------------------------------------------------
const observations = []
let release = { skipped: true }
for (const engine of ENGINES) {
  let browser
  try {
    browser = await BROWSERS[engine].launch()
    if (engine === ENGINES[0]) {
      release = await waitRelease(browser)
      emit({ phase: 'release', ...release })
    }
    const shared = {}
    for (const label of CONTEXTS) {
      const record = await observeContext(browser, engine, label, shared)
      observations.push(record)
      emit({ phase: 'observe', ...record })
    }
  } catch (error) {
    for (const label of CONTEXTS) {
      if (observations.some((o) => o.engine === engine && o.context === label)) continue
      const record = { engine, context: label, fatal: `BROWSER_LAUNCH_FAILED: ${redact(String(error?.message ?? error).split('\n')[0], 200)}` }
      observations.push(record)
      emit({ phase: 'observe', ...record })
    }
  } finally { await browser?.close().catch(() => {}) }
}

const result = verdict(observations, { allowlist: DEFAULT_ALLOWLIST, turn: TURN, expectedBuildSha: EXPECTED_SHA })
if (EXPECTED_SHA && release.ok !== true) result.failures.unshift({ code: 'RELEASE_NOT_OBSERVED', where: 'all', detail: release.code ?? null })
const pass = result.failures.length === 0
const report = { verdict: pass ? 'PASS' : 'FAIL', turn: TURN, expectedBuildSha: EXPECTED_SHA, consensus: result.consensus,
  unavailable: result.unavailable, failures: result.failures }
emit({ phase: 'verdict', ...report })
if (OUT) writeFileSync(OUT, redact(JSON.stringify({ ...report, observations }, null, 2), 2_000_000) + '\n')
process.exit(pass ? 0 : 1)
