/** Offline wake acknowledgement checks with isolated transactional state and no provider I/O. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDurableWakeStore, X61HeadDurableObject } from '../head-do.mjs'

const seedId = 'a'.repeat(64), origin = 'https://wake.example.invalid'
function fixture(options = {}) {
  let now = 1794367000000, rows = new Map([['bootstrap:v1', { phase: 'complete', seedId }]]), alarm = null, tail = Promise.resolve(), failPut = false
  const view = (data, timer) => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { if (failPut && key === 'wake:v1') throw new Error('synthetic failure'); data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async () => structuredClone(data),
    getAlarm: async () => timer.value, setAlarm: async value => { timer.value = value }, deleteAlarm: async () => { timer.value = null },
  })
  const storage = {
    get: key => view(rows, { value: alarm }).get(key),
    getAlarm: async () => alarm,
    transaction(operation) {
      const result = tail.then(async () => {
        const data = structuredClone(rows), timer = { value: alarm }, result = await operation(view(data, timer))
        rows = data; alarm = timer.value; return result
      })
      tail = result.catch(() => {}); return result
    },
  }
  const create = () => createDurableWakeStore(storage, { ...options, now: () => now })
  return { storage, create, advance: () => { now += 60000 }, snapshot: () => structuredClone(rows), fail: value => { failPut = value } }
}

test('latest wake acknowledgement survives reconstruction and does not silently resume paused schedules', async t => {
  const fx = fixture(), wake = fx.create(); t.after(() => wake.dispose())
  await wake.configure({ enabled: true })
  const receipts = []
  for (let i = 0; i < 3; i++) { fx.advance(); receipts.push((await wake.alarm()).receipt) }
  assert.equal((await wake.status()).autoPaused, true)
  const prior = fx.snapshot()
  assert.equal((await wake.acknowledge({ wakeId: receipts[0].wakeId })).code, 'WAKE_ACKNOWLEDGEMENT_STALE')
  assert.deepEqual(fx.snapshot(), prior)
  const accepted = await wake.acknowledge({ wakeId: receipts[2].wakeId })
  assert.equal(accepted.consecutiveUnacknowledgedWakes, 0)
  assert.equal(accepted.autoPaused, false)
  assert.equal(accepted.enabled, false)
  assert.equal(await fx.storage.getAlarm(), null)
  const recreated = fx.create(); t.after(() => recreated.dispose())
  assert.equal((await recreated.status()).consecutiveUnacknowledgedWakes, 0)
  assert.equal((await recreated.acknowledge({ wakeId: receipts[2].wakeId })).idempotent, true)
  await recreated.configure({ enabled: true })
  assert.equal((await recreated.status()).enabled, true)
})

test('successful autonomous probes acknowledge the schedule while unsuccessful probes still pause it', async t => {
  for (const status of ['success', 'blocked', 'failed']) {
    let calls = 0
    const fx = fixture({ runWakeProbe: () => { calls++; return { status } } }), wake = fx.create(); t.after(() => wake.dispose())
    await wake.configure({ enabled: true })
    for (let i = 0; i < 4; i++) { fx.advance(); await wake.alarm() }
    const value = await wake.status()
    assert.equal(value.autoPaused, status !== 'success')
    assert.equal(value.enabled, status === 'success')
    assert.equal(value.consecutiveUnacknowledgedWakes, status === 'success' ? 0 : 3)
    assert.equal(calls, status === 'success' ? 4 : 3)
  }
})

test('manual probe success does not acknowledge earlier alarms and invalid acknowledgements never mutate', async t => {
  let result = 'blocked'
  const fx = fixture({ runWakeProbe: () => ({ status: result }) }), wake = fx.create(); t.after(() => wake.dispose())
  await wake.configure({ enabled: true }); fx.advance(); await wake.alarm()
  result = 'success'; await wake.trigger()
  assert.equal((await wake.status()).consecutiveUnacknowledgedWakes, 1)
  const before = fx.snapshot()
  for (const input of [null, {}, { wakeId: 1 }, { wakeId: 'unknown' }, { wakeId: 'unknown', enabled: true }]) {
    assert.equal((await wake.acknowledge(input)).ok, false)
    assert.deepEqual(fx.snapshot(), before)
  }
  fx.fail(true)
  await assert.rejects(wake.acknowledge({ wakeId: (await wake.status()).receipts.at(-1).wakeId }), /synthetic failure/)
  assert.deepEqual(fx.snapshot(), before)
})

test('acknowledgement HTTP route validates seed, input, idempotency header and latest wake identity', async t => {
  const fx = fixture(), object = new X61HeadDurableObject({ storage: fx.storage, getWebSockets: () => [] }, {})
  t.after(() => object.wakeStore.dispose())
  const receipt = (await object.wakeStore.trigger()).receipt
  const call = async (body, headers = {}) => {
    const response = await object.fetch(new Request(origin + '/_host/wake', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId, ...headers }, body: JSON.stringify(body) }))
    return { status: response.status, value: await response.json() }
  }
  assert.equal((await call({ action: 'acknowledge', wakeId: receipt.wakeId })).status, 200)
  assert.equal((await call({ action: 'acknowledge', wakeId: receipt.wakeId }, { 'idempotency-key': 'not-supported' })).value.code, 'WAKE_REQUEST_INVALID')
  assert.equal((await call({ action: 'acknowledge', wakeId: receipt.wakeId, enabled: true })).status, 400)
  assert.equal((await call({ action: 'acknowledge', wakeId: receipt.wakeId }, { 'x-x6-bootstrap-seed': 'b'.repeat(64) })).status, 503)
  assert.equal((await call({ action: 'acknowledge', wakeId: receipt.wakeId }, { 'x-x6-internal-authorized': '0' })).status, 401)
})
