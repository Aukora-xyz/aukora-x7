import assert from 'node:assert/strict'
import test from 'node:test'
import { createProviderDispatcher } from '../provider-dispatch.mjs'
import { extractDoorTurnSummary, handleInternalTurnJournalRoute, TURN_JOURNAL_RING_LIMIT } from '../turn-journal.mjs'

const bytes = new TextEncoder().encode(JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'test' }] }))
function storage() {
  const data = new Map()
  let tail = Promise.resolve()
  const tx = { get: async key => structuredClone(data.get(key)), put: async (key, value) => data.set(key, structuredClone(value)), delete: async key => data.delete(key) }
  return { ...tx, transaction(fn) { const result = tail.then(() => fn(tx)); tail = result.catch(_error => {}); return result } }
}
const request = (id = 'turn-1', body = bytes, headers = {}) => new Request('https://x61.internal/_head/provider-dispatch', {
  method: 'POST', headers: { 'x-x6-provider': 'anthropic', 'x-x6-provider-endpoint': '/v1/messages', 'x-x6-turn-id': id, ...headers }, body,
})
async function fixture(networkFetch) {
  const store = storage()
  const summary = await extractDoorTurnSummary('anthropic', '/v1/messages', bytes, { turnIdHeader: 'turn-1' })
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', summary)).status, 200)
  return { store, summary, dispatcher: createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch }) }
}

test('cancel aborts upstream before headers and refuses replay after dispatcher recreation', async () => {
  let started, signal, calls = 0
  const ready = new Promise(resolve => { started = resolve })
  const networkFetch = async (_url, init) => { calls++; signal = init.signal; started(); return new Promise(() => {}) }
  const { store, summary, dispatcher } = await fixture(networkFetch)
  const pending = dispatcher.dispatch(request())
  await ready
  dispatcher.cancel('turn-1')
  const cancelled = await handleInternalTurnJournalRoute(store, 'POST', { action: 'cancel', turnId: 'turn-1' })
  assert.equal(cancelled.status, 200)
  assert.equal(signal.aborted, true)
  assert.equal((await pending).status, 409)
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', summary)).status, 409)
  const recreated = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch })
  assert.equal((await recreated.dispatch(request())).status, 409)
  assert.equal(calls, 1)
})

test('streaming cancellation aborts upstream, cancels reader and rejects waiting consumer', async () => {
  let signal, cancelled = 0
  const { dispatcher } = await fixture(async (_url, init) => {
    signal = init.signal
    return new Response(new ReadableStream({ cancel() { cancelled++ } }))
  })
  const response = await dispatcher.dispatch(request())
  const reader = response.body.getReader()
  const read = reader.read()
  dispatcher.cancel('turn-1')
  await assert.rejects(read, /TURN_CANCELLED/)
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, 1)
})

test('cancel during durable checks prevents any upstream dispatch', async () => {
  let calls = 0, release, entered
  const { store, dispatcher } = await fixture(async () => { calls++; return new Response('bad') })
  const old = store.transaction
  const reached = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  store.transaction = async fn => { entered(); await gate; return old(fn) }
  const pending = dispatcher.dispatch(request())
  await reached
  dispatcher.cancel('turn-1')
  release()
  assert.equal((await pending).status, 409)
  assert.equal(calls, 0)
})

test('dispatch requires exact journal evidence and active terminal state blocks late dispatch', async () => {
  let calls = 0
  const { store, dispatcher } = await fixture(async () => { calls++; return new Response('ok') })
  for (const value of [request('missing'), request('turn-1', new TextEncoder().encode('{}')), request('turn-1', bytes, { 'x-x6-provider': 'openai' }), request('turn-1', bytes, { 'x-x6-provider-endpoint': '//evil.invalid' })]) {
    assert.ok((await dispatcher.dispatch(value)).status >= 400)
  }
  await store.put('head:turn:active', { turn_id: 'turn-1', status: 'abandoned' })
  assert.equal((await dispatcher.dispatch(request())).status, 409)
  assert.equal(calls, 0)
})

test('in-flight duplicate and completed replay dispatch only once; transport gets trusted credentials', async () => {
  let finish, started, calls = 0
  const ready = new Promise(resolve => { started = resolve })
  const { dispatcher } = await fixture(async (url, init) => {
    calls++
    assert.equal(url, 'https://api.anthropic.com/v1/messages')
    assert.equal(init.headers.get('x-api-key'), 'fixture-only')
    assert.equal(init.headers.get('authorization'), null)
    started()
    return new Promise(resolve => { finish = () => resolve(new Response('ok')) })
  })
  const pending = dispatcher.dispatch(request('turn-1', bytes, { authorization: 'Bearer attacker' }))
  await ready
  assert.equal((await dispatcher.dispatch(request())).status, 409)
  finish()
  assert.equal(await (await pending).text(), 'ok')
  assert.equal((await dispatcher.dispatch(request())).status, 409)
  assert.equal(calls, 1)
})

test('client stream cancellation aborts upstream', async () => {
  let signal, cancelled = 0
  const { dispatcher } = await fixture(async (_url, init) => {
    signal = init.signal
    return new Response(new ReadableStream({ cancel() { cancelled++ } }))
  })
  const response = await dispatcher.dispatch(request())
  await response.body.cancel()
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, 1)
})


test('late headers from an abort-ignoring transport are discarded', async () => {
  let finish, started, cancelled = 0
  const ready = new Promise(resolve => { started = resolve })
  const { dispatcher } = await fixture(async () => { started(); return new Promise(resolve => { finish = resolve }) })
  const pending = dispatcher.dispatch(request())
  await ready
  dispatcher.cancel('turn-1')
  assert.equal((await pending).status, 409)
  finish(new Response(new ReadableStream({ cancel() { cancelled++ } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, 1)
})

test('active-only cancellation persists a tombstone after active turn replacement', async () => {
  const store = storage()
  await store.put('head:turn:active', { turn_id: 'turn-1', status: 'running' })
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { action: 'cancel', turnId: 'turn-1' })).status, 200)
  await store.put('head:turn:active', { turn_id: 'turn-2', status: 'running' })
  const summary = await extractDoorTurnSummary('anthropic', '/v1/messages', bytes, { turnIdHeader: 'turn-1' })
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', summary)).status, 409)
})


const indexKey = id => `head:turn-journal:turn:${id}`
const parentRequest = id => request(id, bytes, { 'x-x6-parent-turn-id': 'parent-1' })
async function appendChild(store, turnId, parentTurnId = 'parent-1') {
  const summary = await extractDoorTurnSummary('anthropic', '/v1/messages', bytes, { turnIdHeader: turnId, parentTurnIdHeader: parentTurnId })
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', summary)).status, 200)
  return summary
}

test('automatic IDs cannot overwrite an explicit cancelled next-sequence hash ID', async () => {
  const store = storage()
  const summary = await extractDoorTurnSummary('anthropic', '/v1/messages', bytes)
  const collidingId = `turn-2-${summary.requestSha256.slice(0, 16)}`
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { ...summary, turnId: collidingId })).status, 200)
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { action: 'cancel', turnId: collidingId })).status, 200)
  const tombstone = await store.get(indexKey(collidingId))
  const appended = await (await handleInternalTurnJournalRoute(store, 'POST', summary)).json()
  assert.equal(appended.entry.seq, 2)
  assert.match(appended.entry.turnId, /^turn-[0-9a-f-]{36}$/)
  assert.notEqual(appended.entry.turnId, collidingId)
  assert.deepEqual(await store.get(indexKey(collidingId)), tombstone)
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { ...summary, turnId: collidingId })).status, 409)
  let calls = 0
  const dispatcher = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async () => { calls++; return new Response('unexpected') } })
  assert.equal((await dispatcher.dispatch(request(collidingId))).status, 409)
  assert.equal(calls, 0)
})

test('random ID collisions preserve every retained index and fail closed after bounded attempts', async t => {
  const store = storage()
  const retained = [
    { cancelled: true, cancelledAt: 1 }, { abandoned: true },
    { completed: true, completedAt: 2 }, { dispatchedAt: 3 },
  ]
  const ids = retained.map((_value, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  for (let i = 0; i < ids.length; i++) await store.put(indexKey(`turn-${ids[i]}`), retained[i])
  let draws = 0
  const fresh = '00000000-0000-4000-8000-999999999999'
  const randomUUID = t.mock.method(crypto, 'randomUUID', () => ids[draws++] ?? fresh)
  const summary = await extractDoorTurnSummary('anthropic', '/v1/messages', bytes)
  const result = await (await handleInternalTurnJournalRoute(store, 'POST', summary)).json()
  assert.equal(result.entry.turnId, `turn-${fresh}`)
  assert.equal(draws, 5)
  for (let i = 0; i < ids.length; i++) assert.deepEqual(await store.get(indexKey(`turn-${ids[i]}`)), retained[i])
  randomUUID.mock.mockImplementation(() => ids[0])
  const rejected = await handleInternalTurnJournalRoute(store, 'POST', summary)
  assert.equal(rejected.status, 503)
  assert.equal((await rejected.json()).code, 'TURN_JOURNAL_ID_COLLISION')
  assert.equal(randomUUID.mock.callCount(), 13)
  assert.equal(await store.get('head:turn-journal:seq'), 1)
  assert.equal(await store.get('head:turn-journal:row:2'), undefined)
})

test('row eviction and dispatcher recreation preserve all terminal marker forms and dispatched indexes', async () => {
  const store = storage()
  const summary = await extractDoorTurnSummary('anthropic', '/v1/messages', bytes)
  const retained = [
    { cancelled: true, cancelledAt: 1 }, { abandoned: true }, { completed: true, completedAt: 2 }, { dispatchedAt: 3 },
    { status: 'cancelled' }, { status: 'abandoned' }, { abandonedAt: 4 }, { status: 'completed' },
    { cancelledAt: 5 }, { completedAt: 6 },
  ]
  const originals = []
  for (let i = 0; i < retained.length; i++) {
    const id = `retained-${i}`
    assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { ...summary, turnId: id })).status, 200)
    const index = { ...await store.get(indexKey(id)), ...retained[i] }
    await store.put(indexKey(id), index)
    originals.push(index)
  }
  for (let i = 0; i < TURN_JOURNAL_RING_LIMIT; i++) {
    assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { ...summary, turnId: `filler-${i}` })).status, 200)
  }
  const recreated = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async () => assert.fail('Retained IDs must not dispatch after row eviction') })
  for (let i = 0; i < retained.length; i++) {
    assert.equal(await store.get(`head:turn-journal:row:${i + 1}`), undefined)
    assert.deepEqual(await store.get(indexKey(`retained-${i}`)), originals[i])
    assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { ...summary, turnId: `retained-${i}` })).status, 409)
    assert.equal((await recreated.dispatch(request(`retained-${i}`))).status, 409)
  }
})

test('journal idempotency binds the parent, provider and endpoint', async () => {
  const store = storage()
  await store.put('head:turn:active', { turn_id: 'parent-1', status: 'running' })
  const summary = await appendChild(store, 'child-1')
  const again = await (await handleInternalTurnJournalRoute(store, 'POST', summary)).json()
  assert.equal(again.idempotent, true)
  assert.equal(again.entry.parentTurnId, 'parent-1')
  assert.equal((await store.get(indexKey('child-1'))).parentTurnId, 'parent-1')
  for (const altered of [{ parentTurnId: null }, { provider: 'openai' }, { endpoint: '/v1/responses' }]) {
    assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { ...summary, ...altered })).status, 409)
  }
  await store.put('head:turn:active', { turn_id: 'parent-2', status: 'running' })
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { ...summary, parentTurnId: 'parent-2' })).status, 409)
  assert.equal(await store.get('head:turn-journal:seq'), 1)
})

test('append and dispatch reject missing, replaced or terminal parents without upstream work', async () => {
  const cases = [
    [null, null, 'TURN_PARENT_NOT_ACTIVE'],
    [{ turn_id: 'parent-2', status: 'running' }, null, 'TURN_PARENT_NOT_ACTIVE'],
    [{ turn_id: 'parent-1', status: 'abandoned' }, null, 'TURN_CANCELLED'],
    [{ turn_id: 'parent-1', status: 'completed' }, null, 'TURN_COMPLETED'],
    [{ turn_id: 'parent-1', status: 'running' }, { cancelled: true }, 'TURN_CANCELLED'],
    [{ turn_id: 'parent-1', status: 'running' }, { completed: true }, 'TURN_COMPLETED'],
  ]
  for (const [active, tombstone, code] of cases) {
    const store = storage()
    await store.put('head:turn:active', { turn_id: 'parent-1', status: 'running' })
    const summary = await appendChild(store, 'child-1')
    if (active) await store.put('head:turn:active', active)
    else await store.delete('head:turn:active')
    if (tombstone) await store.put(indexKey('parent-1'), tombstone)
    const appended = await handleInternalTurnJournalRoute(store, 'POST', { ...summary, turnId: 'late-child' })
    assert.equal(appended.status, 409)
    assert.equal((await appended.json()).code, code)
    let calls = 0
    const dispatcher = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async () => { calls++; return new Response('unexpected') } })
    const rejected = await dispatcher.dispatch(parentRequest('child-1'))
    assert.equal(rejected.status, 409)
    assert.equal((await rejected.json()).code, code)
    assert.equal(calls, 0)
    assert.equal((await store.get(indexKey('child-1'))).dispatchedAt, undefined)
    assert.equal(await store.get(indexKey('late-child')), undefined)
  }
})

test('dispatch refuses a stripped or changed durable parent association', async () => {
  const store = storage()
  await store.put('head:turn:active', { turn_id: 'parent-1', status: 'running' })
  await appendChild(store, 'child-1')
  const dispatcher = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async () => assert.fail('Parent substitution must not dispatch') })
  for (const candidate of [request('child-1'), request('child-1', bytes, { 'x-x6-parent-turn-id': 'parent-2' })]) {
    const result = await dispatcher.dispatch(candidate)
    assert.equal(result.status, 409)
    assert.equal((await result.json()).code, 'TURN_JOURNAL_CONFLICT')
  }
})

test('parent cancellation reaches every pending and streaming child but not an unassociated request', async () => {
  const store = storage()
  await store.put('head:turn:active', { turn_id: 'parent-1', status: 'running' })
  for (const id of ['done-child', 'header-child-1', 'header-child-2', 'stream-child']) await appendChild(store, id)
  await appendChild(store, 'independent', null)
  let calls = 0, headersStarted, streamCancelled = 0
  const ready = new Promise(resolve => { headersStarted = resolve })
  const signals = []
  const dispatcher = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async (_url, init) => {
    const number = calls++
    signals.push(init.signal)
    if (number === 0) return new Response('finished')
    if (number === 2) headersStarted()
    if (number === 1 || number === 2) return new Promise(() => {})
    return new Response(new ReadableStream({ cancel() { streamCancelled++ } }))
  } })
  assert.equal(await (await dispatcher.dispatch(parentRequest('done-child'))).text(), 'finished')
  const pending = [dispatcher.dispatch(parentRequest('header-child-1')), dispatcher.dispatch(parentRequest('header-child-2'))]
  await ready
  const stream = await dispatcher.dispatch(parentRequest('stream-child'))
  const independent = await dispatcher.dispatch(request('independent'))
  const read = stream.body.getReader().read()
  const rejectedRead = assert.rejects(read, /TURN_CANCELLED/)
  dispatcher.cancel('parent-1')
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { action: 'cancel', turnId: 'parent-1' })).status, 200)
  for (const response of await Promise.all(pending)) assert.equal(response.status, 409)
  await rejectedRead
  assert.deepEqual(signals.map(signal => signal.aborted), [false, true, true, true, false])
  assert.equal(streamCancelled, 1)
  await independent.body.cancel()
  assert.equal(streamCancelled, 2)
  const recreated = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async () => assert.fail('Terminal parent must not dispatch after recreation') })
  assert.equal((await recreated.dispatch(parentRequest('stream-child'))).status, 409)
  assert.equal((await handleInternalTurnJournalRoute(store, 'POST', { action: 'cancel', turnId: 'parent-1' })).status, 200)
})

test('request cancellation aborts only that child and preserves siblings for parent cancellation', async () => {
  const store = storage()
  await store.put('head:turn:active', { turn_id: 'parent-1', status: 'running' })
  for (const id of ['child-1', 'child-2']) await appendChild(store, id)
  const signals = []
  const dispatcher = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async (_url, init) => {
    signals.push(init.signal)
    return new Response(new ReadableStream())
  } })
  const first = await dispatcher.dispatch(parentRequest('child-1'))
  const second = await dispatcher.dispatch(parentRequest('child-2'))
  dispatcher.cancel('child-1')
  assert.deepEqual(signals.map(signal => signal.aborted), [true, false])
  await assert.rejects(first.text(), /TURN_CANCELLED/)
  dispatcher.cancel('parent-1')
  await assert.rejects(second.text(), /TURN_CANCELLED/)
  assert.deepEqual(signals.map(signal => signal.aborted), [true, true])
})

test('parent cancellation during durable claim prevents upstream dispatch', async () => {
  const store = storage()
  await store.put('head:turn:active', { turn_id: 'parent-1', status: 'running' })
  await appendChild(store, 'child-1')
  let release, entered
  const reached = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const transaction = store.transaction
  store.transaction = async fn => { entered(); await gate; return transaction(fn) }
  const dispatcher = createProviderDispatcher({ storage: store, env: { ANTHROPIC_API_KEY: 'fixture-only' }, networkFetch: async () => assert.fail('Cancelled claim must not dispatch') })
  const pending = dispatcher.dispatch(parentRequest('child-1'))
  await reached
  dispatcher.cancel('parent-1')
  release()
  assert.equal((await pending).status, 409)
  assert.equal((await store.get(indexKey('child-1'))).dispatchedAt, undefined)
})
