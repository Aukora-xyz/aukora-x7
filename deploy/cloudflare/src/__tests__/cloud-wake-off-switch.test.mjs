/** Offline executor opt-in checks. All storage and provider responses are synthetic. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject } from '../head-do.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)

function fixture(t, setting, options = {}) {
  let now = 1000000, alarm = null, tail = Promise.resolve()
  let rows = new Map([
    ['bootstrap:v1', { phase: 'complete', seedId: SEED }],
    ['head:current', { ballId: BALL, epoch: 2, entries: {} }],
    ['head:wish:active', { wish_id: 'fixture-wish', intent: 'Inspect continuity', acceptance: 'Record observations', status: 'running', stepsCompleted: 0, maxSteps: 6 }],
  ])
  const view = (data, timer) => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => timer.value,
    setAlarm: async value => { timer.value = value },
    deleteAlarm: async () => { timer.value = null },
  })
  const storage = {
    get: key => view(rows, { value: alarm }).get(key),
    transaction(operation) {
      const result = tail.then(async () => {
        const data = structuredClone(rows), timer = { value: alarm }
        const result = await operation(view(data, timer))
        rows = data; alarm = timer.value
        return result
      })
      tail = result.catch(() => {})
      return result
    },
  }
  const env = { WAKE_EXECUTOR_ENABLED: setting, DEEPSEEK_API_KEY: 'synthetic-provider',
    PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '20', PROVIDER_BUDGET_TOKENS: '1000000', PROVIDER_MAX_OUTPUT_TOKENS: '400' }
  if (setting === undefined) delete env.WAKE_EXECUTOR_ENABLED
  t.mock.method(Date, 'now', () => now)
  const requests = []
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(String(url))
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
    return Response.json({ choices: [{ message: { content: 'Continuity reviewed without claiming acceptance.' } }] })
  })
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, options)
  t.after(() => head.wakeStore.dispose())
  head.broadcast = async () => {}
  const post = async (path, body) => {
    const response = await head.fetch(new Request('https://wake.example.invalid' + path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
    assert.equal(response.status, 200)
    return response.json()
  }
  const executionState = () => new Map([...rows].filter(([key]) => key.startsWith('head:') || key.startsWith('provider-budget:')))
  return { head, env, storage, requests, post, executionState, snapshot: () => structuredClone(rows), advance: () => { now += 60000 } }
}

for (const setting of ['0', undefined, '', 'true', 1]) for (const injected of [false, true]) {
  test(`wake executor refuses ${JSON.stringify(setting)} with injected probe ${injected} before dispatch or execution writes`, async t => {
    let probes = 0
    const f = fixture(t, setting, injected ? { runWakeProbe: () => { probes++; return { status: 'success' } } } : {})
    assert.equal((await f.head.wakeStore.status()).executor.available, false)
    const before = f.snapshot()
    for (const forceWishStep of [false, true]) {
      assert.deepEqual(await f.head.executeCloudWakeStep({ forceWishStep }), { status: 'blocked', reason: 'executor_disabled' })
      assert.deepEqual(f.snapshot(), before)
    }
    const step = await f.post('/_head/transcript', { action: 'wish_step' })
    assert.equal(step.ok, false)
    assert.equal(step.probeStatus, 'blocked')
    assert.deepEqual(f.snapshot(), before)
    const executionBefore = f.executionState()
    const manual = await f.post('/_host/wake', { action: 'trigger' })
    assert.equal(manual.receipt.executor.invoked, false)
    await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
    f.advance()
    const scheduled = await f.head.alarm()
    assert.equal(scheduled.receipt.executor.invoked, false)
    assert.equal(probes, 0)
    assert.deepEqual(f.requests, [])
    assert.deepEqual(f.executionState(), executionBefore)
  })
}

test('explicit opt-in retains direct, wish_step, manual and scheduled provider execution', async t => {
  const f = fixture(t, '1')
  assert.equal((await f.head.wakeStore.status()).executor.available, true)
  assert.deepEqual(await f.head.executeCloudWakeStep(), { status: 'success', toolCalls: 0, evidenceCount: 0 })
  assert.equal((await f.post('/_head/transcript', { action: 'wish_step' })).ok, true)
  assert.deepEqual((await f.post('/_host/wake', { action: 'trigger' })).receipt.executor, { available: true, invoked: true, status: 'probe_succeeded' })
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  for (let index = 0; index < 3; index++) {
    f.advance()
    const scheduled = await f.head.alarm()
    assert.deepEqual(scheduled.receipt.executor, { available: true, invoked: true, status: 'probe_succeeded' })
    assert.equal(scheduled.consecutiveUnacknowledgedWakes, 0)
    assert.equal(scheduled.autoPaused, false)
    assert.equal(scheduled.enabled, true)
  }
  assert.equal(f.requests.length, 6)
  assert.equal((await f.storage.get('head:wish:active')).stepsCompleted, 6)
  assert.equal(await f.storage.get('head:wake:daily:1970-01-01'), 6)
  assert.ok(await f.storage.get('provider-budget:v1:deepseek'))
})

test('explicit opt-in retains injected probes without requiring provider credentials', async t => {
  let probes = 0
  const f = fixture(t, '1', { runWakeProbe: () => { probes++; return { status: 'success' } } })
  delete f.env.DEEPSEEK_API_KEY
  assert.equal((await f.head.wakeStore.trigger()).receipt.executor.status, 'probe_succeeded')
  assert.equal(probes, 1)
  assert.deepEqual(f.requests, [])
})

for (const status of ['failed', 'blocked']) {
  test(`production wake adapter retains ${status} outcomes without invalid receipt metadata`, async t => {
    const f = fixture(t, '1')
    if (status === 'failed') delete f.env.DEEPSEEK_API_KEY
    else await f.storage.transaction(tx => tx.put('head:turn:active', { status: 'running', heartbeat_at: Date.now() }))
    const result = await f.post('/_host/wake', { action: 'trigger' })
    assert.deepEqual(result.receipt.executor, { available: true, invoked: true, status: `probe_${status}` })
    assert.equal((await f.storage.get('head:wish:active')).stepsCompleted, 0)
    assert.deepEqual(f.requests, [])
  })
}

test('injected probes still reject extra result fields', async t => {
  const f = fixture(t, '1', { runWakeProbe: () => ({ status: 'success', extra: true }) })
  assert.deepEqual((await f.head.wakeStore.trigger()).receipt.executor, { available: true, invoked: true, status: 'probe_invalid' })
  assert.deepEqual(f.requests, [])
})
