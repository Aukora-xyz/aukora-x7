#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * SIGNED-OUT LIVE CHECKS for x6.1, in Chromium, Firefox and WebKit, with no credential of any kind.
 *
 * For each engine it opens one brand-new private context and, without signing in:
 *   - loads https://node.example.invalid/ and records the document status, the title and the passkey button;
 *   - reads whether the engine exposes WebAuthn, and waits (bounded) for the passkey button to become enabled;
 *   - GETs /api/build from the page with credentials omitted.
 * It never clicks anything, never asks for a passkey and never sends a sign-in. The pure verdict is
 * ./signed-out-verdict.mjs. The owner-session observation stays in ./observe-fresh-x61.mjs and is not replaced by this.
 *
 * Usage:  X61_PLAYWRIGHT_DIR=<abs dir outside the checkout> X61_EXPECT_BUILD_SHA=<40-hex>
 *           node deploy/ci/observe-signed-out-x61.mjs [--out report.json]
 * Exit:   0 PASS or PARTIAL (nothing failed; something was not performed, and it says what) · 1 FAIL ·
 *         2 UNPERFORMED (no expected commit, or no pinned Playwright outside the checkout).
 * When GITHUB_STEP_SUMMARY is set, it appends what was and was not performed; when GITHUB_OUTPUT is set, it writes
 * `verdict` and `unperformed` for the workflow's aggregate line.
 * It lives under deploy/ (T2) because CI runs it in the deploy pipeline.
 */
import { createRequire } from 'node:module'
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signedOutOutputs, signedOutSummary, signedOutVerdict, SIGNED_OUT_ENGINES } from './signed-out-verdict.mjs'

const ORIGIN = 'https://node.example.invalid'
const PLAYWRIGHT_VERSION = '1.61.1'
const VIEWPORT = { width: 1440, height: 900 }
const PASSKEY_ENABLE_MS = 20_000
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const unperformed = (code, note) => {
  console.error(JSON.stringify({ code, verdict: 'UNPERFORMED', note }))
  process.exit(2)
}

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const OUT = outIndex >= 0 ? args[outIndex + 1] : null
if ((outIndex >= 0 && (!OUT || OUT.startsWith('--'))) || args.some(arg => arg !== '--out' && arg !== OUT)) {
  unperformed('OBSERVER_ARGUMENT_INVALID', 'usage: [--out <report.json>]')
}
const EXPECTED_SHA = String(process.env.X61_EXPECT_BUILD_SHA ?? '').toLowerCase()
if (!/^[0-9a-f]{40}$/.test(EXPECTED_SHA)) unperformed('EXPECTED_SHA_INVALID', 'X61_EXPECT_BUILD_SHA must be the 40-hex commit just deployed. No browser was opened.')

// Same rule as observe-fresh-x61.mjs: Playwright only from an integrity-pinned directory outside the checkout, whose
// dependency tree is T1-writable. Anything else is UNPERFORMED, never a fallback to the workspace copy.
function loadPinnedPlaywright() {
  const dir = process.env.X61_PLAYWRIGHT_DIR ?? ''
  if (!dir || !isAbsolute(dir)) unperformed('PLAYWRIGHT_DIR_MISSING', 'X61_PLAYWRIGHT_DIR must be an absolute directory holding the pinned Playwright. No browser was opened.')
  let root, repo
  try { root = realpathSync(dir); repo = realpathSync(REPO_ROOT) } catch { unperformed('PLAYWRIGHT_UNAVAILABLE', 'X61_PLAYWRIGHT_DIR does not exist. No browser was opened.') }
  if (root === repo || root.startsWith(repo + sep) || repo.startsWith(root + sep)) {
    unperformed('PLAYWRIGHT_DIR_IN_REPO', 'X61_PLAYWRIGHT_DIR overlaps the repository checkout. No browser was opened.')
  }
  const expect = name => join(root, 'node_modules', name, 'package.json')
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
const playwright = loadPinnedPlaywright()

const short = (value, limit = 200) => String(value ?? '').split('\n')[0].slice(0, limit)

async function observeEngine(engine) {
  const record = { engine }
  let browser
  try {
    browser = await playwright[engine].launch()
    const context = await browser.newContext({ locale: 'en-US', viewport: VIEWPORT })
    try {
      const page = await context.newPage()
      const response = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      record.documentStatus = response?.status() ?? null
      record.title = await page.title().catch(() => null)
      record.webauthn = await page.evaluate(() => typeof window.PublicKeyCredential === 'function'
        && typeof navigator.credentials?.get === 'function').catch(() => null)
      const present = await page.evaluate(() => document.getElementById('passkey-submit') !== null).catch(() => false)
      const enabled = present && await page.waitForFunction(() => {
        const button = document.getElementById('passkey-submit')
        return Boolean(button) && button.disabled === false
      }, null, { timeout: PASSKEY_ENABLE_MS, polling: 250 }).then(() => true).catch(() => false)
      record.passkeyButton = { present, enabled }
      record.passkeyStatus = short(await page.evaluate(() => document.getElementById('passkey-status')?.textContent ?? '').catch(() => ''))
      record.build = await page.evaluate(async () => {
        try {
          const answer = await fetch('/api/build', { credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' } })
          return { status: answer.status, contentType: answer.headers.get('content-type') ?? '', body: (await answer.text()).slice(0, 4096) }
        } catch { return { status: -1, contentType: '', body: '' } }
      }).catch(() => ({ status: -2, contentType: '', body: '' }))
    } finally { await context.close().catch(() => {}) }
  } catch (error) {
    record.fatal = `OBSERVER_ERROR: ${short(error?.message ?? error)}`
  } finally { await browser?.close().catch(() => {}) }
  return record
}

const records = []
for (const engine of SIGNED_OUT_ENGINES) {
  const record = await observeEngine(engine)
  records.push(record)
  console.log(JSON.stringify({ phase: 'signed-out', ...record, build: record.build ? { status: record.build.status, contentType: record.build.contentType } : null }))
}
const result = signedOutVerdict(records, { expectedSha: EXPECTED_SHA })
console.log(JSON.stringify({ phase: 'verdict', expectedSha: EXPECTED_SHA, ...result }))
if (OUT) writeFileSync(OUT, JSON.stringify({ expectedSha: EXPECTED_SHA, ...result, records }, null, 2) + '\n')
if (process.env.GITHUB_STEP_SUMMARY) {
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, signedOutSummary(result, EXPECTED_SHA)) } catch { /* the step log above carries the same verdict */ }
}
if (process.env.GITHUB_OUTPUT) {
  try { appendFileSync(process.env.GITHUB_OUTPUT, signedOutOutputs(result)) } catch { /* the summary and the log carry the same verdict */ }
}
process.exit(result.verdict === 'FAIL' ? 1 : 0)
