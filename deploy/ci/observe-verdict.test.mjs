// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/observe-verdict.test.mjs
// Wave 4B Lane E: the fresh-window verdict must never be green without proof
// of memory (a hex receipt Merkle root), the default 'auma' workspace, and an open head WebSocket, in every context.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verdict, headSocketProven, ENGINES, CONTEXTS, REQUIRED_SURFACES, REQUIRED_WORKSPACE } from './observe-verdict.mjs'

const BALL = 'a'.repeat(64)
const ROOT = 'e'.repeat(64)

function observation(engine, context, patch = {}) {
  return {
    engine, context, signedIn: true, appReady: true,
    health: { status: 200, ok: true, ready: true, buildSha: 'c'.repeat(40) },
    head: { status: 200, ballId: BALL, epoch: 167 },
    facts: { status: 200, ok: true, epoch: 167, ballId: BALL, receiptTotal: 120, receiptsVerified: 120,
      checkpointsTotal: 9, lastCheckpointSeq: 9, lastCheckpointReceiptCount: 118, merkleRoot: ROOT },
    workspace: { chip: 'auma' },
    headSocket: { state: 'open', source: 'runtime', runtime: { state: 'open', framesReceived: 1, framesSent: 1, errors: 0, reconnects: 0, reported: true } },
    runtime: { available: true, idle: true, ballId: BALL, epoch: 167, mutation: null,
      persistence: { durable: true, readOnly: false, conflict: null, localError: null, localPendingPaths: 0,
        target: 'https://node.example.invalid/_mirror/delta', sending: false, pendingBatches: 0, pendingBytes: 0,
        mirrorConflict: null, mirrorError: null, reconciliationRequired: false, resyncPending: false, transient: null,
        quarantinedPaths: [], deferredJournals: 0 } },
    surfaces: REQUIRED_SURFACES.map((id) => ({ id, reachable: true })),
    consoleErrors: [], failedRequests: [], httpErrors: [],
    ...patch,
  }
}
const all = (patcher = () => ({})) => ENGINES.flatMap((engine) => CONTEXTS.map((context) => observation(engine, context, patcher(engine, context))))
const one = (target, patch) => all((engine, context) => `${engine}/${context}` === target ? patch(engine, context) : {})
const codes = (result) => result.failures.map((f) => f.code)
const withFacts = (extra) => (engine, context) => ({ facts: { ...observation(engine, context).facts, ...extra } })

test('baseline: six clean contexts with root, auma chip and open socket pass', () => {
  const result = verdict(all())
  assert.equal(result.pass, true, JSON.stringify(result.failures))
  assert.equal(result.consensus.merkleRoot, ROOT)
  assert.equal(REQUIRED_WORKSPACE, 'auma')
})

test("merkleRoot: 'unavailable' in every context is a FAIL, never a pass", () => {
  const result = verdict(all(withFacts({ merkleRoot: 'unavailable' })))
  assert.equal(result.pass, false)
  assert.equal(result.failures.filter((f) => f.code === 'MERKLE_ROOT_UNAVAILABLE').length, 6)
  assert.equal(result.consensus.merkleRoot, 'unavailable')
  assert.ok(result.unavailable.includes('merkleRoot'))
})

test('merkleRoot: absent, null, empty, short, non-hex, padded, number or object all FAIL', () => {
  for (const value of [undefined, null, '', 'e'.repeat(63), 'g'.repeat(64), ` ${ROOT}`, `${ROOT}\n`, 42, { root: ROOT }, ['e']]) {
    const result = verdict(all(withFacts({ merkleRoot: value })))
    assert.equal(result.pass, false, `accepted merkleRoot ${JSON.stringify(value)}`)
    assert.ok(codes(result).includes('MERKLE_ROOT_UNAVAILABLE'))
  }
})

test('merkleRoot: one context without a root fails that context even when five agree', () => {
  const result = verdict(one('webkit/B', withFacts({ merkleRoot: 'unavailable' })))
  assert.equal(result.pass, false)
  assert.deepEqual(result.failures.filter((f) => f.code === 'MERKLE_ROOT_UNAVAILABLE').map((f) => f.where), ['webkit/B'])
  assert.ok(codes(result).includes('MERKLE_ROOT_PARTIAL'))
})

test('merkleRoot: disagreeing roots fail; case-only differences are the same root', () => {
  assert.ok(codes(verdict(one('firefox/A', withFacts({ merkleRoot: 'f'.repeat(64) })))).includes('MERKLE_ROOT_MISMATCH'))
  assert.equal(verdict(one('firefox/A', withFacts({ merkleRoot: ROOT.toUpperCase() }))).pass, true)
})

test("workspace: chip other than exactly 'auma' FAILS in that context", () => {
  for (const workspace of [undefined, null, {}, { chip: '' }, { chip: 'Auma' }, { chip: 'auma ' }, { chip: 'cloud' },
    { chip: 'default' }, { chip: ['auma'] }, { chip: { name: 'auma' } }, 'auma']) {
    const result = verdict(one('webkit/B', () => ({ workspace })))
    assert.equal(result.pass, false, `accepted workspace ${JSON.stringify(workspace)}`)
    assert.deepEqual(result.failures.map((f) => [f.code, f.where]), [['WORKSPACE_NOT_AUMA', 'webkit/B']])
  }
})

test("headSocket: closed, closing, connecting, numeric OPEN, missing or unobserved FAILS", () => {
  for (const headSocket of [undefined, null, {}, { state: 'closed' }, { state: 'closing' }, { state: 'connecting' },
    { state: 'OPEN' }, { state: 1 }, { readyState: 1 }, { state: 'open ' }, 'open', true]) {
    const result = verdict(one('chromium/A', () => ({ headSocket })))
    assert.equal(result.pass, false, `accepted headSocket ${JSON.stringify(headSocket)}`)
    assert.deepEqual(result.failures.map((f) => [f.code, f.where]), [['HEAD_SOCKET_NOT_OPEN', 'chromium/A']])
  }
})

test('all three false-greens at once are each reported', () => {
  const result = verdict(all((engine) => engine === 'firefox'
    ? { ...withFacts({ merkleRoot: 'unavailable' })(engine, 'A'), workspace: { chip: 'cloud' }, headSocket: { state: 'closed' } } : {}))
  for (const code of ['MERKLE_ROOT_UNAVAILABLE', 'WORKSPACE_NOT_AUMA', 'HEAD_SOCKET_NOT_OPEN']) {
    assert.equal(result.failures.filter((f) => f.code === code).length, 2, code)
  }
})

test('a context with incomplete facts fails FACTS_UNAVAILABLE; its root never counts toward consensus', () => {
  const result = verdict(one('webkit/A', () => ({ facts: { status: 503, ok: false, merkleRoot: ROOT } })))
  assert.deepEqual(result.failures.map((f) => [f.code, f.where]), [['FACTS_UNAVAILABLE', 'webkit/A']])
})

test('process exit: a verdict over false-green observations exits non-zero', () => {
  const verdictUrl = new URL('./observe-verdict.mjs', import.meta.url).href
  const script = `
    import { verdict } from ${JSON.stringify(verdictUrl)}
    const observations = JSON.parse(process.argv[1])
    const result = verdict(observations)
    process.exit(result.pass ? 0 : 1)
  `
  const run = (observations) => spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(observations)], { encoding: 'utf8' })
  assert.equal(run(all()).status, 0)
  assert.notEqual(run(all(withFacts({ merkleRoot: 'unavailable' }))).status, 0)
  assert.notEqual(run(one('chromium/B', () => ({ workspace: { chip: 'cloud' } }))).status, 0)
  assert.notEqual(run(one('webkit/A', () => ({ headSocket: { state: 'closed' } }))).status, 0)
  assert.ok(fileURLToPath(verdictUrl).endsWith('observe-verdict.mjs'))
})

// ---- Wave 4G Lane E3: 'open' must be frame-backed by a witness the record carries ------------------------------------
test('headSocket: an open claim without a frame-backed witness FAILS open-unproven', () => {
  for (const headSocket of [{ state: 'open' }, { state: 'open', source: 'runtime' },
    { state: 'open', runtime: { state: 'open', framesReceived: 0, framesSent: 0 } },
    { state: 'open', runtime: { state: 'connecting', framesReceived: 3 } },
    { state: 'open', runtime: { state: 'open', framesReceived: -1, framesSent: 'many' } },
    { state: 'open', page: { state: 'open', open: 0 } }, { state: 'open', open: 0 },
    { state: 'open', page: { state: 'connecting', open: 1 } }]) {
    const result = verdict(one('firefox/B', () => ({ headSocket })))
    assert.equal(result.pass, false, `accepted ${JSON.stringify(headSocket)}`)
    assert.deepEqual(result.failures.map((f) => [f.code, f.where, f.detail]), [['HEAD_SOCKET_NOT_OPEN', 'firefox/B', 'open-unproven']])
  }
})

test('headSocket: worker witness open + frame PASSES with a silent page socket; page witness alone PASSES', () => {
  const silentPage = { state: 'connecting', sockets: 1, open: 0, silent: 1, closed: 0, errors: 0 }
  const viaRuntime = { state: 'open', source: 'runtime', page: silentPage, runtime: { state: 'open', framesReceived: 1, framesSent: 0 } }
  assert.equal(verdict(all(() => ({ headSocket: viaRuntime }))).pass, true)
  assert.equal(verdict(all(() => ({ headSocket: { state: 'open', sockets: 1, open: 1, silent: 0, closed: 0, errors: 0 } }))).pass, true)
  assert.equal(verdict(all(() => ({ headSocket: { state: 'open', source: 'page', page: { state: 'open', open: 1 } } }))).pass, true)
  assert.equal(headSocketProven(viaRuntime), true)
  assert.equal(headSocketProven({ state: 'open' }), false)
  assert.equal(headSocketProven(null), false)
})

test('headSocket: worker connecting (0 frames), closed, errored or absent with no open page socket FAILS', () => {
  const silentPage = { state: 'connecting', sockets: 1, open: 0, silent: 1, closed: 0, errors: 0 }
  for (const [state, runtime] of [['connecting', { state: 'connecting', framesReceived: 0, framesSent: 0 }],
    ['closed', { state: 'closed', framesReceived: 2, framesSent: 1 }], ['closed', { state: 'closed', errors: 3 }],
    ['absent', { state: 'absent' }]]) {
    const result = verdict(one('webkit/A', () => ({ headSocket: { state, source: null, page: silentPage, runtime } })))
    assert.deepEqual(result.failures.map((f) => [f.code, f.where, f.detail]), [['HEAD_SOCKET_NOT_OPEN', 'webkit/A', state]])
  }
})
