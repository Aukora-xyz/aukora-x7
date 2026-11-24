/** Synthetic transports and transactional memory only; no credentials, app launch or network. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createEdgeTurnProbe, EDGE_TURN_PROBE_LIMITS } from '../deploy/cloudflare/src/edge-turn-probe.mjs'
import { createWakeProbeRunner } from '../deploy/cloudflare/src/messages-store.mjs'
import { createDurableWakeStore, manifestId } from '../deploy/cloudflare/src/head-do.mjs'
import { computeAura } from './aura-rules.mjs'

const now = 1700000000000
const head = { ballId: 'a'.repeat(64), epoch: 12 }
const metrics = { reachableDagNodes: 1, declaredDagNodes: 1, verifiedReceipts: 1, totalReceipts: 1,
  activeOrgans: 1, declaredOrgans: 1, observedSurpriseScores: [], handOffEpochMismatch: false,
  unanchoredPredictions: 0, pendingWakes: 0, lastRollbackAgeEpochs: 10, staleHeartbeatRatio: 0.3 }
const context = (selected = head, overrides = {}) => ({ verification: 'verified', wake: { enabled: true },
  aura: computeAura({ ...metrics, ...selected, computedAt: now }), ...overrides })
const reply = (content = 'ATTENTION', extra = {}) => Response.json({ choices: [{ finish_reason: 'stop',
  message: { role: 'assistant', content, ...extra } }] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function timers() {
  const entries = new Map()
  let next = 0
  return { setTimeout(callback) { const id = ++next; entries.set(id, callback); return id },
    clearTimeout(id) { entries.delete(id) },
    fire() { assert.equal(entries.size, 1); const [id, callback] = entries.entries().next().value; entries.delete(id); callback() } }
}

async function storageFixture() {
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 12, entries: {}, modules: {} }
  ball.ballId = await manifestId(ball)
  let rows = new Map([['bootstrap:v1', { phase: 'complete', seedId: 'b'.repeat(64) }], ['head', ball.ballId],
    [`manifest:${ball.ballId}:count`, 1], [`manifest:${ball.ballId}:0`, JSON.stringify(ball)],
    ['mandates:fixture', { unchanged: true }]])
  let alarm = null, queue = Promise.resolve(), failedKey = null
  const storage = {
    get: async key => structuredClone(rows.get(key)), getAlarm: async () => alarm,
    transaction(operation) {
      const result = queue.then(async () => {
        const staged = structuredClone(rows); let nextAlarm = alarm
        const value = await operation({ get: async key => structuredClone(staged.get(key)),
          put: async (key, value) => { if (key === failedKey) throw new Error('synthetic commit failure'); staged.set(key, structuredClone(value)) },
          delete: async key => staged.delete(key), getAlarm: async () => nextAlarm,
          setAlarm: async value => { nextAlarm = value }, deleteAlarm: async () => { nextAlarm = null } })
        rows = staged; alarm = nextAlarm; return value
      })
      queue = result.catch(() => undefined); return result
    },
    snapshot: () => structuredClone(rows), failPut: key => { failedKey = key },
  }
  return { storage, head: { ballId: ball.ballId, epoch: ball.epoch } }
}

test('default and nonboolean opt-in never read context or invoke transport', async () => {
  for (const enabled of [undefined, false, 'true', 1]) {
    const callback = createEdgeTurnProbe({ enabled,
      readContext() { assert.fail('disabled context') }, transport: { fetch() { assert.fail('disabled transport') } } })
    assert.equal(callback, undefined)
    const runner = createWakeProbeRunner({ runWakeProbe: callback })
    assert.equal((await runner.run({ head, now })).status, 'executor_unavailable')
    await runner.dispose()
  }
  assert.equal(createEdgeTurnProbe({ enabled: true }), undefined)
})

test('disabled wake, unknown, corrupt, stale and rest Aura never invoke transport', async () => {
  const rest = computeAura({ ...metrics, staleHeartbeatRatio: 0, ...head, computedAt: now })
  const invalidSignals = { ...rest, vector: { coherence: 0, surprisePressure: 1, driftRisk: 1, wakeUrgency: 1 },
    salience: [{ kind: 'handoff-drift', targetId: head.ballId, score: 1, code: 'invalid-signals' }], recommendedFocus: 'verify' }
  for (const value of [null, context(head, { wake: { enabled: false } }), context(head, { verification: 'unknown' }),
    context(head, { aura: {} }), context(head, { aura: rest }), context({ ...head, epoch: 13 }),
    context(head, { aura: invalidSignals }),
    context(head, { aura: { ...context().aura, computedAt: now - 1 } })]) {
    const run = createEdgeTurnProbe({ enabled: true, readContext: () => value,
      transport: { fetch() { assert.fail('ineligible transport') } } })
    assert.deepEqual(await run({ head, now, signal: new AbortController().signal }), { status: 'blocked' })
  }
})

test('verified attention sends one fixed bounded request without memory or authority', async () => {
  let calls = 0
  const value = context(head, { memory: 'synthetic-private-memory', key: 'synthetic-secret' })
  const run = createEdgeTurnProbe({ enabled: true, readContext: () => value, transport: { async fetch(request) {
    calls++
    assert.equal(request.url, 'https://edge-probe.internal/v1/chat/completions')
    assert.equal(request.redirect, 'error')
    const body = await request.json()
    assert.equal(body.max_tokens, EDGE_TURN_PROBE_LIMITS.maxTokens)
    assert.equal(body.stream, false)
    assert.deepEqual(JSON.parse(body.messages[1].content), { recommendedFocus: 'rest', wakeUrgency: 0.3 })
    assert.equal(Object.hasOwn(body, 'tools'), false)
    for (const absent of ['synthetic-private-memory', 'synthetic-secret', head.ballId]) assert.equal(JSON.stringify(body).includes(absent), false)
    return reply()
  } } })
  const runner = createWakeProbeRunner({ runWakeProbe: run })
  assert.deepEqual(await runner.run({ head, now }), { available: true, invoked: true, status: 'probe_succeeded' })
  assert.equal(calls, 1)
  assert.equal(value.wake.enabled, true)
  await runner.dispose()
})

test('response text, tool calls, oversized bodies and provider errors are never recorded', async () => {
  for (const response of [reply('private response '.repeat(1000)), reply('ATTENTION', { tool_calls: [] }),
    reply('MAKE_A_MANDATE'), new Response('synthetic-secret', { status: 500 }), reply('UNKNOWN'),
    new Response('{'), new Response(new Uint8Array([0xff])),
    new Response('{}', { headers: { 'content-length': '1' } }),
    Response.json({ choices: { length: 1, 0: { finish_reason: 'stop', message: { role: 'assistant', content: 'ATTENTION' } } } }),
    Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'ATTENTION' } }] })]) {
    const runner = createWakeProbeRunner({ runWakeProbe: createEdgeTurnProbe({ enabled: true,
      readContext: () => context(), transport: { fetch: async () => response } }) })
    const result = await runner.run({ head, now })
    assert.ok(['probe_failed', 'probe_blocked'].includes(result.status))
    assert.deepEqual(Object.keys(result).sort(), ['available', 'invoked', 'status'])
    assert.ok(JSON.stringify(result).length < 100)
    await runner.dispose()
  }
})

test('durable successful transport is replay-safe and receipts stay bounded without authority writes', async () => {
  const fixture = await storageFixture(); let calls = 0
  const before = fixture.storage.snapshot()
  const wake = createDurableWakeStore(fixture.storage, { now: () => now,
    runWakeProbe: createEdgeTurnProbe({ enabled: true, readContext: async () => context(fixture.head,
      { wake: await fixture.storage.get('wake:v1') }), transport: { fetch() { calls++; return Promise.resolve(reply()) } } }),
  })
  assert.equal((await wake.trigger()).receipt.status, 'probe_blocked'); assert.equal(calls, 0)
  await wake.configure({ enabled: true })
  const first = await wake.trigger({ requestId: 'one' })
  assert.equal(first.receipt.status, 'probe_succeeded')
  assert.equal((await wake.trigger({ requestId: 'one' })).idempotent, true); assert.equal(calls, 1)
  for (let i = 0; i < 65; i++) await wake.trigger({ requestId: `bounded-${i}` })
  assert.equal((await wake.status()).receipts.length, 64)
  for (const key of ['head', 'mandates:fixture']) assert.deepEqual(await fixture.storage.get(key), before.get(key))
  await wake.dispose()
})

test('pending body cancellation retains durable claim through timeout and restart', async () => {
  const fixture = await storageFixture(), cancelling = deferred(), release = deferred(), clock = timers()
  let calls = 0, elapsed = 0
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(EDGE_TURN_PROBE_LIMITS.responseBytes + 1)) },
    cancel() { cancelling.resolve(); return release.promise },
  }))
  const runWakeProbe = createEdgeTurnProbe({ enabled: true, readContext: () => context(fixture.head),
    transport: { fetch() { calls++; return Promise.resolve(response) } } })
  const options = { now: () => now, runWakeProbe, probeTimeoutMs: 20, monotonicNow: () => elapsed, ...clock }
  const wake = createDurableWakeStore(fixture.storage, options)
  await wake.configure({ enabled: true })
  const request = wake.trigger()
  await cancelling.promise
  elapsed = 20; clock.fire()
  assert.equal((await request).receipt.status, 'probe_timeout')
  const restarted = createDurableWakeStore(fixture.storage, options)
  assert.equal((await restarted.trigger()).code, 'WAKE_PROBE_BUSY')
  assert.ok(await fixture.storage.get('wake:probe-claim:v1'))
  release.resolve(); await wake.dispose()
  assert.equal(await fixture.storage.get('wake:probe-claim:v1'), undefined)
  assert.equal(calls, 1)
  await restarted.dispose()
})

test('durable timeout aborts, survives reconstruction, and retains claim until true settlement', async () => {
  const fixture = await storageFixture(), pending = deferred(), started = deferred(), clock = timers()
  let calls = 0, elapsed = 0, signal
  const before = fixture.storage.snapshot()
  const runWakeProbe = createEdgeTurnProbe({ enabled: true, readContext: () => context(fixture.head), transport: {
    fetch(request) { calls++; signal = request.signal; assert.ok(fixture.storage.snapshot().has('wake:probe-claim:v1')); started.resolve(); return pending.promise },
  } })
  const options = { now: () => now, runWakeProbe, probeTimeoutMs: 20, monotonicNow: () => elapsed, ...clock }
  const wake = createDurableWakeStore(fixture.storage, options)
  await wake.configure({ enabled: true })
  const request = wake.trigger({ requestId: 'timeout-once' })
  await started.promise
  const reconstructed = createDurableWakeStore(fixture.storage, options)
  assert.equal((await reconstructed.trigger()).code, 'WAKE_PROBE_BUSY')
  elapsed = 20; clock.fire()
  const result = await request
  assert.equal(result.receipt.status, 'probe_timeout'); assert.equal(signal.aborted, true)
  assert.ok(await fixture.storage.get('wake:probe-claim:v1'))
  assert.equal((await reconstructed.trigger()).code, 'WAKE_PROBE_BUSY')
  let settled = false
  const disposal = wake.dispose().then(() => { settled = true })
  await Promise.resolve(); assert.equal(settled, false)
  pending.resolve(reply()); await disposal
  assert.equal(await fixture.storage.get('wake:probe-claim:v1'), undefined)
  assert.equal((await reconstructed.status()).receipts[0].status, 'probe_timeout')
  assert.equal(calls, 1)
  for (const key of ['head', 'mandates:fixture']) assert.deepEqual(await fixture.storage.get(key), before.get(key))
  await reconstructed.dispose()
})

test('failed result commit never repeats an uncertain transport after reconstruction', async () => {
  const fixture = await storageFixture(); let calls = 0
  const runWakeProbe = createEdgeTurnProbe({ enabled: true, readContext: () => context(fixture.head), transport: {
    fetch() { calls++; fixture.storage.failPut('wake:v1'); return Promise.resolve(reply()) },
  } })
  const wake = createDurableWakeStore(fixture.storage, { now: () => now, runWakeProbe })
  await wake.configure({ enabled: true })
  await assert.rejects(wake.trigger())
  fixture.storage.failPut(null)
  const reconstructed = createDurableWakeStore(fixture.storage, { now: () => now, runWakeProbe })
  assert.equal((await reconstructed.trigger()).code, 'WAKE_PROBE_BUSY')
  assert.equal(calls, 1)
  await wake.dispose(); await reconstructed.dispose()
})
