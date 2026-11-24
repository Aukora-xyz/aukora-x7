// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/signed-out-verdict.test.mjs  (no browser, no network)
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signedOutOutputs, signedOutSummary, signedOutVerdict, SIGNED_OUT_ENGINES } from './signed-out-verdict.mjs'

const SHA = 'c'.repeat(40)
const RUNNER = fileURLToPath(new URL('./observe-signed-out-x61.mjs', import.meta.url))
const WORKSPACE_PLAYWRIGHT_HOME = fileURLToPath(new URL('../../apps/web', import.meta.url))

const record = (engine, patch = {}) => ({
  engine, documentStatus: 401, title: 'Owner sign-in', webauthn: true, passkeyButton: { present: true, enabled: true },
  build: { status: 200, contentType: 'application/json', body: JSON.stringify({ buildSha: SHA }) }, ...patch,
})
const all = (patcher = () => ({})) => SIGNED_OUT_ENGINES.map(engine => record(engine, patcher(engine)))
const codes = result => result.failures.map(failure => `${failure.code}:${failure.engine}`)

test('every check performed in every engine passes', () => {
  const result = signedOutVerdict(all(), { expectedSha: SHA })
  assert.equal(result.verdict, 'PASS')
  assert.equal(result.performed.length, 9)
  assert.deepEqual(result.unperformed, [])
  assert.deepEqual(SIGNED_OUT_ENGINES, ['chromium', 'firefox', 'webkit'])
})

test('each failed check fails the verdict in the engine where it failed', () => {
  assert.deepEqual(codes(signedOutVerdict(all(e => e === 'firefox' ? { documentStatus: 200 } : {}), { expectedSha: SHA })), ['SIGNIN_PAGE_NOT_RENDERED:firefox'])
  assert.deepEqual(codes(signedOutVerdict(all(e => e === 'webkit' ? { title: 'X6.1' } : {}), { expectedSha: SHA })), ['SIGNIN_PAGE_NOT_RENDERED:webkit'])
  assert.deepEqual(codes(signedOutVerdict(all(e => e === 'chromium' ? { passkeyButton: { present: false, enabled: false } } : {}), { expectedSha: SHA })),
    ['SIGNIN_PAGE_NOT_RENDERED:chromium', 'PASSKEY_BUTTON_NOT_ENABLED:chromium'])
  assert.deepEqual(codes(signedOutVerdict(all(e => e === 'webkit' ? { passkeyButton: { present: true, enabled: false } } : {}), { expectedSha: SHA })), ['PASSKEY_BUTTON_NOT_ENABLED:webkit'])
  const stale = { status: 200, contentType: 'application/json', body: JSON.stringify({ buildSha: 'd'.repeat(40) }) }
  assert.deepEqual(codes(signedOutVerdict(all(e => e === 'firefox' ? { build: stale } : {}), { expectedSha: SHA })), ['BUILD_NOT_EXPECTED:firefox'])
  const signedOutRefused = { status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }) }
  assert.deepEqual(codes(signedOutVerdict(all(() => ({ build: signedOutRefused })), { expectedSha: SHA })),
    ['BUILD_NOT_EXPECTED:chromium', 'BUILD_NOT_EXPECTED:firefox', 'BUILD_NOT_EXPECTED:webkit'])
})

test('a missing, duplicated or crashed engine fails and none of its checks count as performed', () => {
  const missing = signedOutVerdict(all().filter(row => row.engine !== 'webkit'), { expectedSha: SHA })
  assert.deepEqual(codes(missing), ['ENGINE_NOT_OBSERVED:webkit'])
  assert.equal(missing.performed.some(item => item.engine === 'webkit'), false)
  assert.equal(missing.unperformed.filter(item => item.engine === 'webkit').length, 3)
  assert.deepEqual(codes(signedOutVerdict([...all(), record('firefox')], { expectedSha: SHA })), ['ENGINE_NOT_OBSERVED:firefox'])
  const crashed = signedOutVerdict(all(e => e === 'chromium' ? { fatal: 'OBSERVER_ERROR: launch' } : {}), { expectedSha: SHA })
  assert.deepEqual(codes(crashed), ['ENGINE_FATAL:chromium'])
  assert.equal(crashed.performed.some(item => item.engine === 'chromium'), false)
  assert.equal(signedOutVerdict(null, { expectedSha: SHA }).verdict, 'FAIL')
  assert.equal(signedOutVerdict(all(), { expectedSha: 'abc' }).verdict, 'FAIL')
})

test('an engine without WebAuthn reports the passkey check UNPERFORMED, never passed, and the aggregate says PARTIAL', () => {
  const result = signedOutVerdict(all(e => e === 'webkit' ? { webauthn: false, passkeyButton: { present: true, enabled: false } } : {}), { expectedSha: SHA })
  // Nothing failed, but not everything ran, so this is PARTIAL, never plain PASS.
  assert.equal(result.verdict, 'PARTIAL')
  assert.match(signedOutSummary(result, SHA), /: PARTIAL\n/)
  assert.match(signedOutSummary(result, SHA), /- PARTIAL coverage: webkit:passkey not performed/)
  assert.equal(signedOutOutputs(result), 'verdict=PARTIAL\nunperformed=webkit:passkey\n')
  assert.equal(signedOutOutputs(signedOutVerdict(all(), { expectedSha: SHA })), 'verdict=PASS\nunperformed=\n')
  assert.deepEqual(result.unperformed, [{ engine: 'webkit', check: 'passkey', reason: 'ENGINE_HAS_NO_WEBAUTHN' }])
  assert.equal(result.performed.some(item => item.engine === 'webkit' && item.check === 'passkey'), false)
  assert.match(signedOutSummary(result, SHA), /- webkit: performed signin, build; passkey UNPERFORMED \(ENGINE_HAS_NO_WEBAUTHN\)/)
  // Unknown is not "absent": it fails.
  const unread = signedOutVerdict(all(e => e === 'firefox' ? { webauthn: null } : {}), { expectedSha: SHA })
  assert.deepEqual(codes(unread), ['WEBAUTHN_UNREAD:firefox'])
})

test('summary names the verdict, every engine and every failure', () => {
  const result = signedOutVerdict(all(e => e === 'firefox' ? { documentStatus: 500 } : {}), { expectedSha: SHA })
  const text = signedOutSummary(result, SHA)
  assert.match(text, new RegExp(`Signed-out checks of ${SHA}: FAIL`))
  for (const engine of SIGNED_OUT_ENGINES) assert.match(text, new RegExp(`- ${engine}: performed`))
  assert.match(text, /- FAIL SIGNIN_PAGE_NOT_RENDERED \(firefox\)/)
})

test('the runner is UNPERFORMED (exit 2) without an expected commit or a pinned Playwright outside the checkout, and opens no browser', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'x61-signed-out-'))
  try {
    const run = env => spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, ...env } })
    const cases = [
      [{}, 'EXPECTED_SHA_INVALID'],
      [{ X61_EXPECT_BUILD_SHA: 'abc' }, 'EXPECTED_SHA_INVALID'],
      [{ X61_EXPECT_BUILD_SHA: SHA }, 'PLAYWRIGHT_DIR_MISSING'],
      [{ X61_EXPECT_BUILD_SHA: SHA, X61_PLAYWRIGHT_DIR: 'relative/dir' }, 'PLAYWRIGHT_DIR_MISSING'],
      [{ X61_EXPECT_BUILD_SHA: SHA, X61_PLAYWRIGHT_DIR: join(scratch, 'absent') }, 'PLAYWRIGHT_UNAVAILABLE'],
      [{ X61_EXPECT_BUILD_SHA: SHA, X61_PLAYWRIGHT_DIR: WORKSPACE_PLAYWRIGHT_HOME }, 'PLAYWRIGHT_DIR_IN_REPO'],
      [{ X61_EXPECT_BUILD_SHA: SHA, X61_PLAYWRIGHT_DIR: scratch }, 'PLAYWRIGHT_UNPINNED'],
    ]
    for (const [env, code] of cases) {
      const result = run(env)
      assert.equal(result.status, 2, `${code}: ${result.stderr}`)
      assert.equal(JSON.parse(result.stderr.trim()).code, code)
      assert.equal(JSON.parse(result.stderr.trim()).verdict, 'UNPERFORMED')
      assert.equal(result.stdout, '')
    }
    const badArgs = spawnSync(process.execPath, [RUNNER, '--unknown'], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, X61_EXPECT_BUILD_SHA: SHA } })
    assert.equal(badArgs.status, 2)
    assert.equal(JSON.parse(badArgs.stderr.trim()).code, 'OBSERVER_ARGUMENT_INVALID')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
