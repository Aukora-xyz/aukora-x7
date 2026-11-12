// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * PURE VERDICT for the signed-out live checks (deploy/ci/observe-signed-out-x61.mjs). No I/O, no clock.
 *
 * These are the checks that need no owner session, run in every engine (Chromium, Firefox, WebKit) after a deploy:
 *   signin   GET / as a fresh private window renders the owner sign-in page (status 401, title 'Owner sign-in',
 *            the passkey button present: deploy/cloudflare/src/worker.mjs OWNER_SIGNIN_HTML).
 *   passkey  the 'Sign in with passkey' button becomes enabled. Performed only where the engine itself exposes WebAuthn
 *            (window.PublicKeyCredential and navigator.credentials.get, read by the observer, not by the page); in an
 *            engine without it the check is reported UNPERFORMED for that engine, never as passed.
 *   build    GET /api/build (signed out) returns exactly the commit just deployed.
 * Every check that was not performed is listed by engine and check, so a summary can say exactly what ran.
 * The aggregate is built from both lists: FAIL when any performed check failed, PASS only when every
 * check ran in every engine, and PARTIAL when nothing failed but something was not performed. PARTIAL is not a failure of
 * the release, and it is never reported as plain success.
 */
import { parseBuildSha } from './deploy-guard.mjs'

export const SIGNED_OUT_ENGINES = Object.freeze(['chromium', 'firefox', 'webkit'])
export const SIGNED_OUT_CHECKS = Object.freeze(['signin', 'passkey', 'build'])
const SHA40 = /^[0-9a-f]{40}$/

/**
 * @param {unknown[]} records One per engine: { engine, fatal?, documentStatus, title, passkeyButton: { present, enabled },
 *   webauthn, build: { status, contentType, body } }.
 * @param {{ expectedSha: string }} options
 * @returns {{ verdict: 'PASS'|'PARTIAL'|'FAIL', failures: {code: string, engine: string, detail?: unknown}[],
 *   performed: {engine: string, check: string}[], unperformed: {engine: string, check: string, reason: string}[] }}
 */
export function signedOutVerdict(records, { expectedSha } = {}) {
  const failures = [], performed = [], unperformed = []
  const expected = typeof expectedSha === 'string' ? expectedSha.toLowerCase() : ''
  if (!SHA40.test(expected)) failures.push({ code: 'EXPECTED_SHA_INVALID', engine: 'all' })
  const list = Array.isArray(records) ? records : []
  for (const engine of SIGNED_OUT_ENGINES) {
    const rows = list.filter(row => row && typeof row === 'object' && row.engine === engine)
    if (rows.length !== 1) {
      failures.push({ code: 'ENGINE_NOT_OBSERVED', engine, detail: rows.length })
      for (const check of SIGNED_OUT_CHECKS) unperformed.push({ engine, check, reason: 'ENGINE_NOT_OBSERVED' })
      continue
    }
    const [row] = rows
    if (typeof row.fatal === 'string' && row.fatal) {
      failures.push({ code: 'ENGINE_FATAL', engine, detail: row.fatal.slice(0, 200) })
      for (const check of SIGNED_OUT_CHECKS) unperformed.push({ engine, check, reason: 'ENGINE_FATAL' })
      continue
    }
    const rendered = row.documentStatus === 401 && row.title === 'Owner sign-in' && row.passkeyButton?.present === true
    performed.push({ engine, check: 'signin' })
    if (!rendered) failures.push({ code: 'SIGNIN_PAGE_NOT_RENDERED', engine, detail: { status: row.documentStatus ?? null, title: typeof row.title === 'string' ? row.title.slice(0, 80) : null } })
    if (row.webauthn === true) {
      performed.push({ engine, check: 'passkey' })
      if (row.passkeyButton?.enabled !== true) failures.push({ code: 'PASSKEY_BUTTON_NOT_ENABLED', engine })
    } else if (row.webauthn === false) {
      unperformed.push({ engine, check: 'passkey', reason: 'ENGINE_HAS_NO_WEBAUTHN' })
    } else {
      failures.push({ code: 'WEBAUTHN_UNREAD', engine })
      unperformed.push({ engine, check: 'passkey', reason: 'WEBAUTHN_UNREAD' })
    }
    performed.push({ engine, check: 'build' })
    const seen = parseBuildSha(row.build?.status, row.build?.contentType, row.build?.body)
    if (seen === null || seen !== expected) failures.push({ code: 'BUILD_NOT_EXPECTED', engine, detail: { status: row.build?.status ?? null, buildSha: seen } })
  }
  const verdict = failures.length ? 'FAIL' : unperformed.length ? 'PARTIAL' : 'PASS'
  return { verdict, failures, performed, unperformed }
}

/** Markdown lines for the job summary: what ran, what failed, and what was not performed. */
export function signedOutSummary(result, expectedSha) {
  const lines = [`#### Signed-out checks of ${String(expectedSha).slice(0, 40)}: ${result.verdict}`]
  for (const engine of SIGNED_OUT_ENGINES) {
    const ran = result.performed.filter(item => item.engine === engine).map(item => item.check)
    const skipped = result.unperformed.filter(item => item.engine === engine).map(item => `${item.check} UNPERFORMED (${item.reason})`)
    lines.push(`- ${engine}: performed ${ran.length ? ran.join(', ') : 'nothing'}${skipped.length ? `; ${skipped.join('; ')}` : ''}`)
  }
  for (const failure of result.failures) lines.push(`- FAIL ${failure.code} (${failure.engine})`)
  if (result.verdict === 'PARTIAL') lines.push(`- PARTIAL coverage: ${unperformedList(result)} not performed`)
  return lines.join('\n') + '\n'
}

/** `engine:check` for every check not performed, comma separated (empty when coverage is complete). */
export function unperformedList(result) {
  return result.unperformed.map(item => `${item.engine}:${item.check}`).join(', ')
}

/** Step outputs for the workflow's aggregate line: the verdict and what was not performed. */
export function signedOutOutputs(result) {
  return `verdict=${result.verdict}\nunperformed=${unperformedList(result)}\n`
}
