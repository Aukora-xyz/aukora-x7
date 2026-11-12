// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/observe-fresh-x61.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { verdict, compileAllowlist, ENGINES, CONTEXTS, REQUIRED_SURFACES } from './observe-verdict.mjs'

const BALL = 'a'.repeat(64)
const OTHER_BALL = 'b'.repeat(64)
const ROOT = 'e'.repeat(64)
const OBSERVER = fileURLToPath(new URL('./observe-fresh-x61.mjs', import.meta.url))
const WORKSPACE_PLAYWRIGHT_HOME = fileURLToPath(new URL('../../apps/web', import.meta.url))
// A well-formed compact JWS with no signing value behind it; the observer must stop before any network use.
const FAKE_JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ0ZXN0LW9ubHkifQ.dGVzdC1vbmx5LXNpZ25hdHVyZS1ieXRlcw'

function observation(engine, context, patch = {}) {
  return {
    engine, context, signedIn: true, appReady: true,
    health: { status: 200, ok: true, ready: true, buildSha: 'c'.repeat(40) },
    head: { status: 200, ballId: BALL, epoch: 167 },
    facts: { status: 200, ok: true, epoch: 167, ballId: BALL, receiptTotal: 120, receiptsVerified: 120,
      checkpointsTotal: 9, lastCheckpointSeq: 9, lastCheckpointReceiptCount: 118, merkleRoot: ROOT },
    workspace: { chip: 'auma' }, headSocket: { state: 'open', source: 'runtime', runtime: { state: 'open', framesReceived: 1, framesSent: 1, errors: 0, reconnects: 0, reported: true } },
    runtime: { available: true, idle: true, ballId: BALL, epoch: 167, mutation: null,
      persistence: { durable: true, readOnly: false, conflict: null, localError: null, localPendingPaths: 0,
        target: 'https://node.example.invalid/_mirror/delta', sending: false, pendingBatches: 0, pendingBytes: 0,
        mirrorConflict: null, mirrorError: null, reconciliationRequired: false, resyncPending: false, transient: null,
        quarantinedPaths: [], deferredJournals: 0 } },
    surfaces: REQUIRED_SURFACES.map((id) => ({ id, active: id, shown: true, placeholder: false, reachable: true })),
    consoleErrors: [], failedRequests: [], httpErrors: [],
    ...patch,
  }
}

const all = (patcher = () => ({})) => ENGINES.flatMap((engine) => CONTEXTS.map((context) => observation(engine, context, patcher(engine, context))))
const codes = (result) => result.failures.map((f) => f.code)

test('PASS: six identical, clean, fully reachable contexts', () => {
  const result = verdict(all())
  assert.equal(result.pass, true, JSON.stringify(result.failures))
  assert.equal(result.consensus.epoch, 167)
  assert.equal(result.consensus.ballId, BALL)
  assert.equal(result.consensus.receiptTotal, 120)
  assert.equal(result.consensus.checkpointsTotal, 9)
  // Wave 4B: a green run must carry the same hex Merkle root in every context (observe-verdict.test.mjs covers refusal).
  assert.equal(result.consensus.merkleRoot, ROOT)
  assert.ok(!result.unavailable.includes('merkleRoot'))
})

test('FAIL: epoch mismatch between engines', () => {
  const result = verdict(all((engine, context) => engine === 'webkit' && context === 'B'
    ? { head: { status: 200, ballId: BALL, epoch: 168 }, facts: { ...observation(engine, context).facts, epoch: 168 },
      runtime: { ...observation(engine, context).runtime, epoch: 168 } } : {}))
  assert.equal(result.pass, false)
  assert.ok(codes(result).includes('HEAD_EPOCH_MISMATCH'))
})

test('FAIL: ballId mismatch between contexts A and B', () => {
  const result = verdict(all((engine, context) => engine === 'firefox' && context === 'B'
    ? { head: { status: 200, ballId: OTHER_BALL, epoch: 167 }, facts: { ...observation(engine, context).facts, ballId: OTHER_BALL },
      runtime: { ...observation(engine, context).runtime, ballId: OTHER_BALL } } : {}))
  assert.equal(result.pass, false)
  assert.ok(codes(result).includes('HEAD_BALLID_MISMATCH'))
})

test('FAIL: a protected surface is missing', () => {
  const result = verdict(all((engine, context) => engine === 'chromium' && context === 'A'
    ? { surfaces: REQUIRED_SURFACES.filter((id) => id !== 'aumlok').map((id) => ({ id, reachable: true })) } : {}))
  assert.equal(result.pass, false)
  const failure = result.failures.find((f) => f.code === 'SURFACE_UNREACHABLE')
  assert.equal(failure.where, 'chromium/A')
  assert.equal(failure.detail.id, 'aumlok')
})

test('FAIL: a surface that opened but is not shown is unreachable', () => {
  const result = verdict(all((engine, context) => engine === 'webkit' && context === 'A'
    ? { surfaces: REQUIRED_SURFACES.map((id) => ({ id, reachable: id !== 'settings' })) } : {}))
  assert.equal(result.pass, false)
  assert.ok(codes(result).includes('SURFACE_UNREACHABLE'))
})

test('FAIL: a quarantined path', () => {
  const result = verdict(all((engine, context) => engine === 'firefox' && context === 'A' ? { runtime: { ...observation(engine, context).runtime,
    persistence: { ...observation(engine, context).runtime.persistence, quarantinedPaths: ['/dsh/home/auma/too-big.bin'] } } } : {}))
  assert.equal(result.pass, false)
  assert.deepEqual(result.failures.find((f) => f.code === 'PERSISTENCE_QUARANTINED').detail, ['/dsh/home/auma/too-big.bin'])
})

test('FAIL: pending saves, an unsaved remote mutation and an unobservable runtime', () => {
  const pending = verdict(all((engine, context) => engine === 'chromium' && context === 'B' ? { runtime: { ...observation(engine, context).runtime,
    persistence: { ...observation(engine, context).runtime.persistence, pendingBatches: 2 } } } : {}))
  assert.ok(codes(pending).includes('PERSISTENCE_PENDING'))
  const unsaved = verdict(all((engine, context) => engine === 'chromium' && context === 'B' ? { runtime: { ...observation(engine, context).runtime,
    mutation: { ballId: BALL, remoteSaved: false } } } : {}))
  assert.ok(codes(unsaved).includes('PERSISTENCE_REMOTE_UNSAVED'))
  const hidden = verdict(all((engine, context) => engine === 'webkit' && context === 'A' ? { runtime: { available: false, reason: 'TRANSPORT_ABSENT' } } : {}))
  assert.ok(codes(hidden).includes('RUNTIME_STATUS_UNAVAILABLE'))
})

test('FAIL: a console error; PASS only when an explicit, justified allowlist entry covers it', () => {
  const noisy = all((engine, context) => engine === 'chromium' && context === 'A' ? { consoleErrors: ['x6-ball: example boot failure'] } : {})
  const failed = verdict(noisy)
  assert.equal(failed.pass, false)
  assert.ok(codes(failed).includes('CONSOLE_ERROR'))
  const allowlist = [{ id: 'example-entry', kind: 'console', pattern: '^x6-ball: example boot failure$',
    justification: 'Test fixture only: proves an explicit justified entry is honoured.', engines: ['chromium'] }]
  assert.equal(verdict(noisy, { allowlist }).pass, true)
  // The same entry scoped to another engine does not cover it.
  assert.equal(verdict(noisy, { allowlist: [{ ...allowlist[0], engines: ['webkit'] }] }).pass, false)
})

test('allowlist entries without a justification are refused, never applied', () => {
  assert.throws(() => compileAllowlist([{ id: 'no-reason', kind: 'console', pattern: '.*.*' }]), /ALLOWLIST_INVALID/)
  assert.throws(() => verdict(all(), { allowlist: [{ id: 'short', kind: 'console', pattern: 'abcd', justification: 'too short' }] }), /ALLOWLIST_INVALID/)
})

test('FAIL: failed and aborted requests and HTTP errors are counted', () => {
  const aborted = verdict(all((engine, context) => engine === 'firefox' && context === 'B'
    ? { failedRequests: [{ method: 'POST', path: '/_mirror/delta', failure: 'NS_BINDING_ABORTED' }] } : {}))
  assert.ok(codes(aborted).includes('REQUEST_FAILED'))
  const http = verdict(all((engine, context) => engine === 'webkit' && context === 'B'
    ? { httpErrors: [{ method: 'GET', path: '/_head/status', status: 503 }] } : {}))
  assert.ok(codes(http).includes('HTTP_ERROR'))
})

test('FAIL: a missing context, a fatal context and a build mismatch', () => {
  const missing = verdict(all().filter((o) => !(o.engine === 'webkit' && o.context === 'B')))
  assert.ok(codes(missing).includes('CONTEXT_MISSING'))
  const fatal = verdict(all((engine, context) => engine === 'firefox' && context === 'A' ? { fatal: 'OWNER_SIGNIN_REFUSED_401' } : {}))
  assert.ok(codes(fatal).includes('CONTEXT_FATAL'))
  assert.ok(codes(verdict(all(), { expectedBuildSha: 'd'.repeat(40) })).includes('BUILD_MISMATCH'))
})

test('FAIL: receipt facts that differ between contexts', () => {
  const result = verdict(all((engine, context) => engine === 'chromium' && context === 'B'
    ? { facts: { ...observation(engine, context).facts, receiptTotal: 121 } } : {}))
  assert.ok(result.failures.some((f) => f.code === 'FACTS_MISMATCH' && f.detail.key === 'receiptTotal'))
})

test('FAIL: facts 503 / ok:false in all six contexts (a broken receipt or checkpoint chain) is never green', () => {
  // mirror-do.mjs:943-945 + verified-facts.mjs:394 + head-do.mjs:1291: AURA_CHECKPOINT_INVALID surfaces only as this shape.
  const broken = { status: 503, ok: false, attempts: 4, epoch: null, ballId: null, receiptTotal: null, receiptsVerified: null,
    checkpointsTotal: null, lastCheckpointSeq: null, lastCheckpointReceiptCount: null }
  const result = verdict(all(() => ({ facts: broken })))
  assert.equal(result.pass, false)
  assert.equal(result.failures.filter((f) => f.code === 'FACTS_UNAVAILABLE').length, 6)
  assert.deepEqual(result.failures.find((f) => f.code === 'FACTS_UNAVAILABLE').detail, { status: 503, ok: false, attempts: 4 })
  assert.ok(!result.unavailable.includes('facts'))
})

test('FAIL: facts missing or incomplete in a single context', () => {
  const one = verdict(all((engine, context) => engine === 'webkit' && context === 'A' ? { facts: { status: 200, ok: false } } : {}))
  assert.deepEqual(one.failures.map((f) => [f.code, f.where]), [['FACTS_UNAVAILABLE', 'webkit/A']])
  const absent = verdict(all((engine, context) => engine === 'chromium' && context === 'B' ? { facts: undefined } : {}))
  assert.ok(codes(absent).includes('FACTS_UNAVAILABLE'))
})

test('complete facts: counts required, checkpoint fields null only with zero checkpoints, untrusted signer fails', () => {
  const patch = (facts) => () => ({ facts: { ...observation('chromium', 'A').facts, ...facts } })
  assert.equal(verdict(all(patch({ checkpointsTotal: 0, lastCheckpointSeq: null, lastCheckpointReceiptCount: null }))).pass, true)
  assert.ok(codes(verdict(all(patch({ lastCheckpointSeq: null })))).includes('FACTS_INVALID'))
  assert.ok(codes(verdict(all(patch({ receiptTotal: null, receiptsVerified: null })))).includes('FACTS_INVALID'))
  assert.ok(codes(verdict(all(patch({ receiptsVerified: 119 })))).includes('FACTS_RECEIPTS_UNVERIFIED'))
  assert.equal(verdict(all(patch({ checkpointSignerTrust: 'pinned' }))).pass, true)
  assert.equal(verdict(all(patch({ checkpointSignerTrust: 'unpinned' }))).pass, true)
  assert.ok(codes(verdict(all(patch({ checkpointSignerTrust: 'mismatch' })))).includes('FACTS_SIGNER_UNTRUSTED'))
  assert.ok(codes(verdict(all(patch({ checkpointSignerTrust: 'invalid-pin' })))).includes('FACTS_SIGNER_UNTRUSTED'))
})

test('Merkle roots must agree across every context', () => {
  const root = (value) => (engine, context) => ({ facts: { ...observation(engine, context).facts, merkleRoot: value(engine, context) } })
  assert.equal(verdict(all(root(() => 'e'.repeat(64)))).consensus.merkleRoot, 'e'.repeat(64))
  assert.ok(codes(verdict(all(root((engine) => engine === 'webkit' ? 'f'.repeat(64) : 'e'.repeat(64))))).includes('MERKLE_ROOT_MISMATCH'))
})

test('--turn: B must restore the marker with zero model requests', () => {
  const turned = (b) => all((engine, context) => ({ turn: context === 'A'
    ? { typed: true, markerHere: true, settled: true, threadId: 't1' } : b }))
  assert.equal(verdict(turned({ markerThere: true, modelRequests: 0 }), { turn: true }).pass, true)
  assert.ok(codes(verdict(turned({ markerThere: true, modelRequests: 1 }), { turn: true })).includes('TURN_RESTORE_SPENT_MODEL'))
  assert.ok(codes(verdict(turned({ markerThere: false, modelRequests: 0 }), { turn: true })).includes('TURN_NOT_RESTORED'))
})

test('observer: missing credential exits 2 UNPERFORMED without opening a browser', () => {
  const env = { ...process.env }
  delete env.X61_OWNER_JWT
  const run = spawnSync(process.execPath, [OBSERVER], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /OWNER_CREDENTIAL_MISSING/)
  assert.match(run.stderr, /UNPERFORMED/)
  assert.equal(run.stdout, '')
})

test('observer: a malformed credential exits 2 and is never echoed', () => {
  const secret = 'not-a-jwt-but-secret-material-1234567890'
  const run = spawnSync(process.execPath, [OBSERVER], { env: { ...process.env, X61_OWNER_JWT: secret }, encoding: 'utf8', timeout: 30000 })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /OWNER_CREDENTIAL_MALFORMED/)
  assert.ok(!run.stderr.includes(secret) && !run.stdout.includes(secret))
})

test('observer: an unknown argument is refused without echoing it', () => {
  const run = spawnSync(process.execPath, [OBSERVER, 'eyJleample.secret.value'], { env: { ...process.env, X61_OWNER_JWT: 'aaaa.bbbb.cccc' }, encoding: 'utf8', timeout: 30000 })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /OBSERVER_ARGUMENT_INVALID/)
  assert.ok(!run.stderr.includes('secret.value'))
})

function runObserver(extraEnv) {
  const env = { ...process.env, X61_OWNER_JWT: FAKE_JWT, ...extraEnv }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  delete env.DEBUG; delete env.PWDEBUG; delete env.X61_EXPECT_BUILD_SHA
  const run = spawnSync(process.execPath, [OBSERVER], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(run.status, 2, run.stderr)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /UNPERFORMED/)
  for (const part of FAKE_JWT.split('.')) assert.ok(!run.stderr.includes(part))
  return run
}

test('observer: refuses to run without a pinned Playwright directory', () => {
  assert.match(runObserver({ X61_PLAYWRIGHT_DIR: undefined }).stderr, /PLAYWRIGHT_DIR_MISSING/)
  assert.match(runObserver({ X61_PLAYWRIGHT_DIR: 'relative/pw' }).stderr, /PLAYWRIGHT_DIR_MISSING/)
  assert.match(runObserver({ X61_PLAYWRIGHT_DIR: '/nonexistent-x61-playwright-pin-dir' }).stderr, /PLAYWRIGHT_UNAVAILABLE/)
})

test('observer: never loads Playwright from the T1-writable workspace tree', () => {
  // apps/web resolves a real playwright through the workspace install; the observer must refuse it anyway.
  assert.match(runObserver({ X61_PLAYWRIGHT_DIR: WORKSPACE_PLAYWRIGHT_HOME }).stderr, /PLAYWRIGHT_DIR_IN_REPO/)
})

test('observer: a directory outside the checkout without the exact pinned packages is refused', () => {
  // The Node binary's own directory exists, lies outside any checkout, and holds no node_modules/playwright.
  assert.match(runObserver({ X61_PLAYWRIGHT_DIR: dirname(process.execPath) }).stderr, /PLAYWRIGHT_UNPINNED/)
})

// ---- Wave 4E Lane E2: the observer records the chip and the head socket the verdict judges ---------------------------
// The observer cannot be imported (it reads the credential and opens browsers at load), so its pure capture block is
// loaded on its own: exactly the text between the markers, which must stay free of I/O.
const OBSERVER_SOURCE = readFileSync(OBSERVER, 'utf8')
const CAPTURE_BLOCK = (() => {
  const start = OBSERVER_SOURCE.indexOf('// <capture-helpers>'), end = OBSERVER_SOURCE.indexOf('// </capture-helpers>')
  assert.ok(start > 0 && end > start, 'capture-helpers markers present')
  return OBSERVER_SOURCE.slice(start, end)
})()
const capture = await import(`data:text/javascript;base64,${Buffer.from(CAPTURE_BLOCK).toString('base64')}`)

test('capture block: pure (no imports, process, network, filesystem or clock)', () => {
  assert.doesNotMatch(CAPTURE_BLOCK, /\bimport\b|\brequire\(|\bprocess\.|\bfetch\(|\bDate\.now\(|readFileSync|writeFileSync|X61_OWNER_JWT/)
  assert.equal(capture.HEAD_SOCKET_PATH, '/_head/ws')
  assert.equal(capture.WORKSPACE_CHIP_LABEL, 'Choose workspace')
})

test('chipFromText: only a real label becomes a chip; placeholder, blank and missing are null', () => {
  assert.deepEqual(capture.chipFromText('auma'), { chip: 'auma', placeholder: false, present: true })
  assert.deepEqual(capture.chipFromText('  auma \n'), { chip: 'auma', placeholder: false, present: true })
  assert.deepEqual(capture.chipFromText('Choose workspace'), { chip: null, placeholder: true, present: true })
  assert.deepEqual(capture.chipFromText(' Choose\n workspace '), { chip: null, placeholder: true, present: true })
  assert.deepEqual(capture.chipFromText('   '), { chip: null, placeholder: false, present: true })
  assert.deepEqual(capture.chipFromText(null), { chip: null, placeholder: false, present: false })
  assert.deepEqual(capture.chipFromText(undefined), { chip: null, placeholder: false, present: false })
  assert.equal(capture.chipFromText('cloud-session-7').chip, 'cloud-session-7')
  assert.equal(capture.chipFromText('x'.repeat(500)).chip.length, 120)
})

test('headSocketState: open only for a live /_head/ws socket that carried a frame', () => {
  const ws = (patch = {}) => ({ path: '/_head/ws', closed: false, framesReceived: 0, framesSent: 0, errors: 0, ...patch })
  assert.equal(capture.headSocketState([]).state, 'absent')
  assert.equal(capture.headSocketState(undefined).state, 'absent')
  assert.equal(capture.headSocketState([ws({ path: '/other/ws', framesReceived: 3 })]).state, 'absent')
  assert.equal(capture.headSocketState([ws()]).state, 'connecting')
  assert.equal(capture.headSocketState([ws({ framesReceived: 1 })]).state, 'open')
  assert.equal(capture.headSocketState([ws({ framesSent: 1 })]).state, 'open')
  assert.equal(capture.headSocketState([ws({ framesReceived: 4, closed: true })]).state, 'closed')
  // A reconnect: the first socket closed, the second is greeted.
  assert.deepEqual(capture.headSocketState([ws({ framesReceived: 2, closed: true, errors: 1 }), ws({ framesReceived: 1 })]),
    { state: 'open', sockets: 2, open: 1, silent: 0, closed: 1, errors: 1 })
  // A worker socket the browser reports without frames stays silent beside an open page socket, and alone is not open.
  assert.deepEqual(capture.headSocketState([ws(), ws({ framesReceived: 1 })]), { state: 'open', sockets: 2, open: 1, silent: 1, closed: 0, errors: 0 })
  // Garbage counters never count as frames.
  assert.equal(capture.headSocketState([ws({ framesReceived: -1, framesSent: 'many' })]).state, 'connecting')
  assert.equal(capture.headSocketState([null, 7, ws({ framesReceived: Number.NaN })]).state, 'connecting')
})

test('captured facts drive the verdict: real auma + open socket passes, every other capture fails closed', () => {
  const ws = (patch = {}) => ({ path: '/_head/ws', closed: false, framesReceived: 1, framesSent: 0, errors: 0, ...patch })
  const captured = (chipText, sockets) => () => ({ workspace: capture.chipFromText(chipText), headSocket: capture.headSocketState(sockets) })
  assert.equal(verdict(all(captured('auma', [ws()]))).pass, true)
  const placeholder = verdict(all(captured('Choose workspace', [ws()])))
  assert.deepEqual([...new Set(codes(placeholder))], ['WORKSPACE_NOT_AUMA'])
  assert.equal(placeholder.failures[0].detail, null)
  assert.deepEqual([...new Set(codes(verdict(all(captured(null, [ws()])))))], ['WORKSPACE_NOT_AUMA'])
  assert.deepEqual([...new Set(codes(verdict(all(captured('Auma', [ws()])))))], ['WORKSPACE_NOT_AUMA'])
  for (const [sockets, state] of [[[], 'absent'], [[ws({ framesReceived: 0 })], 'connecting'], [[ws({ closed: true })], 'closed']]) {
    const result = verdict(all(captured('auma', sockets)))
    assert.deepEqual([...new Set(codes(result))], ['HEAD_SOCKET_NOT_OPEN'])
    assert.equal(result.failures[0].detail, state)
  }
})

test('observer wiring: the capture is recorded on every booted context, from the browser\'s own socket events', () => {
  assert.match(OBSERVER_SOURCE, /page\.on\('websocket', \(socket\) => \{/)
  for (const event of ['framereceived', 'framesent', 'socketerror', 'close']) assert.ok(OBSERVER_SOURCE.includes(`socket.on('${event}'`), event)
  // Frame payloads are never read: no frame handler takes an argument.
  assert.doesNotMatch(OBSERVER_SOURCE, /socket\.on\('frame(?:received|sent)', \(\s*[a-z]/)
  const ready = OBSERVER_SOURCE.indexOf('record.appReady = true')
  const socket = OBSERVER_SOURCE.indexOf('record.headSocket = await readHeadSocket(page, sockets)')
  const chip = OBSERVER_SOURCE.indexOf('record.workspace = await readWorkspace(page)')
  assert.ok(ready > 0 && socket > ready && chip > ready, 'recorded right after the app is ready')
})

// ---- Wave 4G Lane E3: her worker's own socket report is the second witness ------------------------------------------
test('runtimeHeadSocket: the runtime report is re-judged, never trusted', () => {
  assert.deepEqual(capture.runtimeHeadSocket({ state: 'open', framesReceived: 2, framesSent: 1, errors: 0, reconnects: 0 }),
    { state: 'open', framesReceived: 2, framesSent: 1, errors: 0, reconnects: 0, reported: true })
  // An open claim without a frame is only connecting.
  assert.equal(capture.runtimeHeadSocket({ state: 'open', framesReceived: 0, framesSent: 0 }).state, 'connecting')
  assert.equal(capture.runtimeHeadSocket({ state: 'open', framesReceived: -3, framesSent: 'many' }).state, 'connecting')
  assert.equal(capture.runtimeHeadSocket({ state: 'open', framesReceived: Number.NaN }).state, 'connecting')
  for (const state of ['connecting', 'closed', 'absent']) assert.equal(capture.runtimeHeadSocket({ state, framesReceived: 5 }).state, state)
  for (const raw of [undefined, null, 'open', 1, [], { state: 'OPEN', framesReceived: 1 }, { state: 1 }, { readyState: 1, framesReceived: 1 }]) {
    assert.equal(capture.runtimeHeadSocket(raw).state, 'absent', JSON.stringify(raw))
  }
  assert.equal(capture.runtimeHeadSocket(undefined).reported, false)
})

test('resolveHeadSocket: either witness proving open with a frame makes the context open', () => {
  const ws = (patch = {}) => ({ path: '/_head/ws', closed: false, framesReceived: 0, framesSent: 0, errors: 0, ...patch })
  const silentWorker = capture.headSocketState([ws()]) // Playwright: her worker socket, frames never reported
  assert.equal(silentWorker.state, 'connecting')
  const viaRuntime = capture.resolveHeadSocket(silentWorker, capture.runtimeHeadSocket({ state: 'open', framesReceived: 1, framesSent: 1 }))
  assert.equal(viaRuntime.state, 'open')
  assert.equal(viaRuntime.source, 'runtime')
  const viaPage = capture.resolveHeadSocket(capture.headSocketState([ws({ framesReceived: 1 })]), capture.runtimeHeadSocket(null))
  assert.deepEqual([viaPage.state, viaPage.source], ['open', 'page'])
  const both = capture.resolveHeadSocket(capture.headSocketState([ws({ framesReceived: 1 })]), capture.runtimeHeadSocket({ state: 'open', framesSent: 1 }))
  assert.equal(both.source, 'page+runtime')
  // Neither proves open: the runtime's state wins when it reported, else the page's.
  assert.equal(capture.resolveHeadSocket(silentWorker, capture.runtimeHeadSocket({ state: 'closed', framesReceived: 3 })).state, 'closed')
  assert.equal(capture.resolveHeadSocket(capture.headSocketState([]), capture.runtimeHeadSocket(undefined)).state, 'absent')
  assert.equal(capture.resolveHeadSocket(silentWorker, capture.runtimeHeadSocket(undefined)).state, 'connecting')
})

test('worker socket open + frame passes the verdict even when Playwright shows the page socket silent', () => {
  const ws = (patch = {}) => ({ path: '/_head/ws', closed: false, framesReceived: 0, framesSent: 0, errors: 0, ...patch })
  const resolved = (sockets, runtime) => () => ({ headSocket: capture.resolveHeadSocket(capture.headSocketState(sockets), capture.runtimeHeadSocket(runtime)) })
  const pass = verdict(all(resolved([ws()], { state: 'open', framesReceived: 1, framesSent: 1, errors: 0, reconnects: 0 })))
  assert.equal(pass.pass, true, JSON.stringify(pass.failures))
  for (const [runtime, detail] of [
    [{ state: 'connecting', framesReceived: 0, framesSent: 0 }, 'connecting'],
    [{ state: 'open', framesReceived: 0, framesSent: 0 }, 'connecting'], // zero-frame open claim
    [{ state: 'closed', framesReceived: 4, framesSent: 1, errors: 0 }, 'closed'],
    [{ state: 'closed', framesReceived: 0, framesSent: 0, errors: 2 }, 'closed'], // errored
    [{ state: 'absent', framesReceived: 0, framesSent: 0 }, 'absent'],
    [undefined, 'connecting'], // runtime unreadable: the silent page socket decides
  ]) {
    const result = verdict(all(resolved([ws()], runtime)))
    assert.deepEqual([...new Set(codes(result))], ['HEAD_SOCKET_NOT_OPEN'], JSON.stringify(runtime))
    assert.equal(result.failures[0].detail, detail, JSON.stringify(runtime))
  }
  // No page socket and no runtime report at all.
  const none = verdict(all(resolved([], undefined)))
  assert.equal(none.failures[0].detail, 'absent')
})

test('observer wiring: the runtime witness is read from /__x6__/status and resolved with the page capture', () => {
  assert.ok(OBSERVER_SOURCE.includes('resolveHeadSocket(headSocketState(sockets), runtimeHeadSocket(runtime?.headSocket))'))
  assert.match(OBSERVER_SOURCE, /headSocket: s\?\.headSocket && typeof s\.headSocket === 'object'/)
  assert.ok(OBSERVER_SOURCE.includes("transport.fetch('/__x6__/status')"))
})
