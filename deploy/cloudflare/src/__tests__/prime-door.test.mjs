/**
 * The Prime Intellect door. One constant origin, five settings, a durable day and month spending cap in HEAD's
 * storage that both paths pass (the browser door and the no-tab wake), settle-down on the wake, give-back for a call
 * that never left the edge, and the key never in anything the door answers or records.
 * Synthetic storage and transport only: no live provider is ever called, and the key here is a planted marker.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, bootstrapPackage, canonicalBootstrap, digest, manifestId } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { createProviderDispatcher } from '../provider-dispatch.mjs'
import { cloudModelDoorStatus, callCloudModel, CLOUD_MODEL_PROVIDERS } from '../cloud-model-door.mjs'
import { cloudWakeProvider } from '../cloud-wake-tools.mjs'
import { PRIME_MODEL_PRICES, PRIME_ORIGIN, PRIME_SETTING_NAMES, PRIME_SPEND_KEY, primeConfigured, primeModelAllowed, primeSettings, providerBudgetLimits, providerRequestReservation, reserveProviderBudget, settlePrimeSpend } from '../provider-budget.mjs'

const MARKER = 'prime-key-MARKER-7f3a9c1e5b2d4086'
const ORIGIN = 'https://prime-fixture.example.invalid'
const BUDGET = { PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '1000', PROVIDER_BUDGET_TOKENS: '1000000', PROVIDER_MAX_OUTPUT_TOKENS: '4096' }
const PRIME = { PRIME_API_KEY: MARKER, PRIME_DAILY_CAP_USD: '10', PRIME_MONTHLY_CAP_USD: '150', PRIME_PRICE_IN_PER_M_USD: '2', PRIME_PRICE_OUT_PER_M_USD: '10' }
const T0 = Date.UTC(2026, 10, 14, 12) // UTC
const NEXT_DAY = Date.UTC(2026, 10, 15), NEXT_MONTH = Date.UTC(2026, 11, 1)

function memoryStorage(initial = [], onPut = () => {}) {
  let rows = new Map(initial), tail = Promise.resolve()
  const view = data => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)); onPut(key, data) },
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = { ...Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(key => [key, (...args) => view(rows)[key](...args)])) }
  storage.transaction = operation => {
    const next = tail.then(async () => { const copy = structuredClone(rows); const result = await operation(view(copy)); rows = copy; return result })
    tail = next.catch(() => {})
    return next
  }
  storage.snapshot = () => structuredClone(rows)
  storage.idle = () => tail
  return storage
}

const spend = async storage => (await storage.get(PRIME_SPEND_KEY)) ?? null
const MODEL = 'deepseek/deepseek-v4-flash'
const reserve = (storage, env, now, { tokens = 1000, outputTokens = 400, model = MODEL } = {}) => reserveProviderBudget(storage, { provider: 'prime', tokens, outputTokens, model }, providerBudgetLimits(env), now)

test('prime is configured only with all five settings, and each absent or malformed one is named exactly', () => {
  assert.deepEqual(PRIME_SETTING_NAMES, ['PRIME_API_KEY', 'PRIME_DAILY_CAP_USD', 'PRIME_MONTHLY_CAP_USD', 'PRIME_PRICE_IN_PER_M_USD', 'PRIME_PRICE_OUT_PER_M_USD'])
  assert.equal(primeConfigured(PRIME), true)
  assert.deepEqual(cloudModelDoorStatus(PRIME).prime, true)
  for (const name of PRIME_SETTING_NAMES) {
    const absent = { ...PRIME }; delete absent[name]
    assert.equal(primeConfigured(absent), false, name)
    assert.deepEqual(primeSettings(absent), { ok: false, missing: name })
    assert.equal(cloudModelDoorStatus(absent).prime, false, name)
    for (const bad of ['', ' ', 'Bearer ']) assert.deepEqual(primeSettings({ ...PRIME, [name]: bad }), { ok: false, missing: name }, `${name}=${JSON.stringify(bad)}`)
  }
  for (const name of PRIME_SETTING_NAMES.slice(1)) {
    for (const bad of ['1e3', '-1', '+1', ' 1', '1.', '.5', '0x10', '01', '1.1234567', '1000000', 10]) assert.deepEqual(primeSettings({ ...PRIME, [name]: bad }), { ok: false, missing: name }, `${name}=${bad}`)
  }
  // A price of zero would make the cap count nothing; a cap of zero is the off switch.
  assert.deepEqual(primeSettings({ ...PRIME, PRIME_PRICE_IN_PER_M_USD: '0' }), { ok: false, missing: 'PRIME_PRICE_IN_PER_M_USD' })
  assert.equal(primeSettings({ ...PRIME, PRIME_DAILY_CAP_USD: '0' }).ok, true)
  assert.deepEqual(primeSettings({ ...PRIME, PRIME_TEAM_ID: 'team id with spaces' }), { ok: false, missing: 'PRIME_TEAM_ID' })
  assert.equal(primeSettings({ ...PRIME, PRIME_TEAM_ID: 'team_42-a' }).teamId, 'team_42-a')
  assert.equal(JSON.stringify(primeSettings(PRIME)).includes(MARKER), false)
  assert.equal(JSON.stringify(providerBudgetLimits({ ...BUDGET, ...PRIME })).includes(MARKER), false)
})

test('a reservation without every setting is refused by name, and writes nothing', async () => {
  const storage = memoryStorage()
  for (const name of PRIME_SETTING_NAMES) {
    const env = { ...BUDGET, ...PRIME }; delete env[name]
    await assert.rejects(reserve(storage, env, T0), { code: 'PRIME_NOT_CONFIGURED', missing: name })
  }
  // Without its output share a prime reservation is malformed; other providers keep their exact input shape.
  await assert.rejects(reserveProviderBudget(storage, { provider: 'prime', tokens: 10 }, providerBudgetLimits({ ...BUDGET, ...PRIME }), T0), { code: 'PROVIDER_BUDGET_REQUEST_INVALID' })
  await assert.rejects(reserveProviderBudget(storage, { provider: 'openai', tokens: 10, outputTokens: 1 }, providerBudgetLimits(BUDGET), T0), { code: 'PROVIDER_BUDGET_REQUEST_INVALID' })
  assert.deepEqual(storage.snapshot(), new Map())
})

test('the estimate is an upper bound in micro-dollars, the day cap refuses with retryAt at the next UTC midnight, and a refusal writes nothing', async () => {
  const storage = memoryStorage(), env = { ...BUDGET, ...PRIME, PRIME_DAILY_CAP_USD: '0.01' }
  // 600 input units x $2/M + 400 output units x $10/M = 1,200 + 4,000 micro-dollars.
  const first = await reserve(storage, env, T0)
  assert.equal(first.spend.estimateMicroUsd, 5200)
  assert.deepEqual([first.spend.day, first.spend.month], ['2026-11-14', '2026-11'])
  const before = storage.snapshot()
  await assert.rejects(reserve(storage, env, T0 + 1), { code: 'SPEND_CAP_EXCEEDED', window: 'day', retryAt: NEXT_DAY, status: 429 })
  assert.deepEqual(storage.snapshot(), before)
  assert.equal((await spend(storage)).dayMicros, 5200)
  // The next UTC day opens again.
  assert.equal((await reserve(storage, env, NEXT_DAY)).spend.day, '2026-11-15')
  assert.equal((await spend(storage)).dayMicros, 5200)
  assert.equal((await spend(storage)).monthMicros, 10400)
})

test('the month cap refuses with retryAt at the first of next month, and the month rolls over by itself', async () => {
  const storage = memoryStorage(), env = { ...BUDGET, ...PRIME, PRIME_MONTHLY_CAP_USD: '0.0104' }
  await reserve(storage, env, T0)
  await reserve(storage, env, NEXT_DAY)
  await assert.rejects(reserve(storage, env, NEXT_DAY + 1), { code: 'SPEND_CAP_EXCEEDED', window: 'month', retryAt: NEXT_MONTH })
  const opened = await reserve(storage, env, NEXT_MONTH)
  assert.deepEqual([opened.spend.day, opened.spend.month], ['2026-12-01', '2026-12'])
  assert.deepEqual([(await spend(storage)).dayMicros, (await spend(storage)).monthMicros], [5200, 5200])
  // A backward clock never reopens a window that has already been counted past.
  await assert.rejects(reserve(storage, { ...env, PRIME_MONTHLY_CAP_USD: '0.0052' }, T0), { code: 'SPEND_CAP_EXCEEDED', window: 'month', retryAt: Date.UTC(2027, 0, 1) })
})

test('the counters live in HEAD storage: a new HEAD instance over the same storage keeps counting and refusing', async () => {
  const storage = memoryStorage([['bootstrap:v1', { phase: 'complete', seedId: 'a'.repeat(64) }]]), env = { ...BUDGET, ...PRIME, PRIME_DAILY_CAP_USD: '0.01' }
  const ask = head => head.fetch(new Request('https://x61.internal/_head/provider-budget', { method: 'POST',
    headers: { 'x-x6-internal-authorized': '1', 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'prime', tokens: 1000, outputTokens: 400, model: MODEL }) }))
  const first = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  const granted = await ask(first)
  assert.equal(granted.status, 200)
  assert.equal((await granted.json()).spend.estimateMicroUsd, 5200)
  const second = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  const refused = await ask(second)
  assert.equal(refused.status, 429)
  const answer = await refused.json()
  assert.equal(answer.code, 'SPEND_CAP_EXCEEDED')
  assert.equal(answer.window, 'day')
  assert.equal(Number.isSafeInteger(answer.retryAt), true)
  assert.equal((await spend(storage)).dayMicros, 5200)
  // Missing settings are named through HEAD too, never as a storage failure.
  const bare = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, { ...BUDGET, ...PRIME, PRIME_PRICE_OUT_PER_M_USD: undefined })
  const unconfigured = await ask(bare)
  assert.equal(unconfigured.status, 503)
  assert.deepEqual(await unconfigured.json(), { ok: false, code: 'PRIME_NOT_CONFIGURED', status: 503, missing: 'PRIME_PRICE_OUT_PER_M_USD' })
})

test('settling is once per charge, never above the estimate, and a give-back on a later day leaves that day alone', async () => {
  const storage = memoryStorage(), env = { ...BUDGET, ...PRIME }
  const { spend: charge } = await reserve(storage, env, T0)
  assert.deepEqual(await settlePrimeSpend(storage, charge.chargeId, { inputUnits: 100, outputUnits: 20 }), { ok: true, settled: true, chargedMicroUsd: 400 })
  assert.deepEqual(await settlePrimeSpend(storage, charge.chargeId, { inputUnits: 0, outputUnits: 0 }), { ok: true, settled: false })
  assert.equal((await spend(storage)).dayMicros, 400)
  const { spend: big } = await reserve(storage, env, T0)
  assert.equal((await settlePrimeSpend(storage, big.chargeId, { inputUnits: 10 ** 7, outputUnits: 10 ** 7 })).chargedMicroUsd, 5200)
  const { spend: old } = await reserve(storage, env, T0)
  await reserve(storage, env, NEXT_DAY)
  await settlePrimeSpend(storage, old.chargeId, { inputUnits: 0, outputUnits: 0 })
  assert.deepEqual([(await spend(storage)).day, (await spend(storage)).dayMicros, (await spend(storage)).monthMicros], ['2026-11-15', 5200, 400 + 5200 + 5200])
  for (const forged of ['not-a-charge', null, 42]) assert.equal((await settlePrimeSpend(storage, forged, { inputUnits: 0, outputUnits: 0 })).settled, false)
})

function dispatchFixture(env, networkFetch) {
  const storage = memoryStorage()
  return { storage, dispatcher: createProviderDispatcher({ storage, env, networkFetch }) }
}

test('the browser dispatch goes to the constant origin with Bearer, content-type and the team header only when set', async () => {
  for (const team of [undefined, 'team_42']) {
    const env = { ...BUDGET, ...PRIME, ...(team ? { PRIME_TEAM_ID: team } : {}) }
    const seen = []
    const { dispatcher } = dispatchFixture(env, async (url, init) => { seen.push({ url, headers: new Headers(init.headers) }); return Response.json({ data: [] }) })
    const response = await dispatcher.dispatch(new Request('https://x61.internal/_head/provider-dispatch', { method: 'GET', headers: { 'x-x6-provider': 'prime', 'x-x6-provider-endpoint': '/v1/models' } }))
    assert.equal(response.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, 'https://api.pinference.ai/api/v1/models')
    assert.equal(PRIME_ORIGIN, 'https://api.pinference.ai/api')
    // The Worker's own table names the same constant (a source pin: the Worker keeps its rows as literals).
    assert.match(readFileSync(new URL('../worker.mjs', import.meta.url), 'utf8'), new RegExp(String.raw`^  prime: \{ origin: '${PRIME_ORIGIN.replaceAll('.', '\\.')}', secret: 'PRIME_API_KEY' \},$`, 'm'))
    assert.equal(seen[0].headers.get('authorization'), `Bearer ${MARKER}`)
    assert.equal(seen[0].headers.get('content-type'), 'application/json')
    assert.equal(seen[0].headers.get('x-prime-team-id'), team ?? null)
    assert.equal(seen[0].headers.get('x-api-key'), null)
    assert.equal(seen[0].headers.get('anthropic-version'), null)
  }
})

test('a browser charge whose call never leaves the edge is given back, and the provider is never called', async () => {
  let calls = 0
  const env = { ...BUDGET, ...PRIME }
  const { storage, dispatcher } = dispatchFixture(env, async () => { calls++; return new Response('no') })
  const { spend: charge } = await reserve(storage, env, Date.now())
  assert.equal((await spend(storage)).dayMicros, 5200)
  // A POST without its journal identity is refused before any byte leaves.
  const refused = await dispatcher.dispatch(new Request('https://x61.internal/_head/provider-dispatch', { method: 'POST',
    headers: { 'x-x6-provider': 'prime', 'x-x6-provider-endpoint': '/v1/chat/completions', 'x-x6-spend-charge': charge.chargeId }, body: '{}' }))
  assert.equal(refused.status, 400)
  assert.equal(calls, 0)
  assert.equal((await spend(storage)).dayMicros, 0)
  assert.deepEqual((await spend(storage)).open, {})
})

function wakeHead(env, { onPut } = {}) {
  const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
  const storage = memoryStorage([
    ['bootstrap:v1', { phase: 'complete', seedId: SEED }],
    ['head:current', { ballId: BALL, epoch: 2, entries: { organ: {} } }],
    ['head:wish:active', { wish_id: 'fixture-wish', intent: 'Inspect continuity', acceptance: 'Record observed facts', status: 'running', stepsCompleted: 0, maxSteps: 6 }],
  ], onPut)
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, { WAKE_EXECUTOR_ENABLED: '1', ...BUDGET, ...env })
  head.broadcast = async () => {}
  return { storage, head }
}

test('CLOUD_WAKE_PROVIDER=prime picks prime; with its secret absent it answers PROVIDER_SECRET_NOT_CONFIGURED and calls nothing', async t => {
  assert.equal(Object.hasOwn(CLOUD_MODEL_PROVIDERS, 'prime'), true)
  assert.equal(CLOUD_MODEL_PROVIDERS.prime.url, 'https://api.pinference.ai/api/v1/chat/completions')
  assert.deepEqual(cloudWakeProvider({ ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', DEEPSEEK_API_KEY: 'synthetic-deepseek' }), { ok: true, provider: 'prime' })
  const absent = { ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', DEEPSEEK_API_KEY: 'synthetic-deepseek' }; delete absent.PRIME_API_KEY
  assert.deepEqual(cloudWakeProvider(absent), { ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED', tried: ['prime'] })
  const urls = []
  t.mock.method(globalThis, 'fetch', async url => { urls.push(String(url)); return Response.json({}) })
  const { head } = wakeHead(absent)
  assert.deepEqual(await head.executeCloudWakeStep({ now: T0 }), { status: 'failed', reason: 'provider_unavailable', cause: 'provider_secret_not_configured' })
  assert.deepEqual(urls, [])
  // Prime is spent only through a path that reserves first: the bare one-shot door refuses it.
  assert.deepEqual(await callCloudModel({ env: PRIME, provider: 'prime', model: 'fixture/model', messages: [{ role: 'user', content: 'hi' }] }), { ok: false, code: 'SPEND_RESERVATION_REQUIRED', provider: 'prime' })
})

test('the wake charges prime before it sends, then settles down to the usage the whole answer reports', async t => {
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) })
    return Response.json({ choices: [{ message: { content: 'Continuity reviewed without claiming acceptance.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })
  })
  const { storage, head } = wakeHead({ ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: 'deepseek/deepseek-v4-flash', PRIME_TEAM_ID: 'team_42' })
  assert.equal((await head.executeCloudWakeStep({ now: T0 })).status, 'success')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://api.pinference.ai/api/v1/chat/completions')
  assert.equal(sent[0].headers.get('authorization'), `Bearer ${MARKER}`)
  assert.equal(sent[0].headers.get('x-prime-team-id'), 'team_42')
  assert.equal(sent[0].body.model, 'deepseek/deepseek-v4-flash')
  const row = await spend(storage)
  // 100 x $2/M + 20 x $10/M = 400 micro-dollars, down from the reserved estimate.
  assert.deepEqual([row.dayMicros, row.monthMicros, Object.keys(row.open).length], [400, 400, 0])
})

test('a wake answer without usage keeps the estimate; a wake over the cap refuses before any call', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ choices: [{ message: { content: 'Continuity reviewed without claiming acceptance.' } }] }) })
  const env = { ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: 'deepseek/deepseek-v4-flash' }
  const kept = wakeHead(env)
  assert.equal((await kept.head.executeCloudWakeStep({ now: T0 })).status, 'success')
  assert.equal((await spend(kept.storage)).dayMicros > 4000, true)
  const capped = wakeHead({ ...env, PRIME_DAILY_CAP_USD: '0.001' })
  assert.equal((await capped.head.executeCloudWakeStep({ now: T0 })).status === 'success', false)
  assert.equal(calls, 1)
  assert.equal(await spend(capped.storage), null)
})

test('a wake at its daily step limit reserves nothing and sends nothing', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}) })
  const day = `head:wake:daily:${new Date(T0).toISOString().slice(0, 10)}`
  const { storage, head } = wakeHead({ ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: MODEL })
  await storage.put(day, 48)
  const outcome = await head.executeCloudWakeStep({ now: T0 })
  assert.deepEqual([outcome.status, outcome.cause, outcome.budget], ['blocked', 'budget_reached', 'wake_steps_per_day'])
  assert.equal(calls, 0)
  assert.equal(await spend(storage), null)
  assert.equal(await storage.get('provider-budget:v1:prime'), undefined)
  assert.equal(await storage.get('head:transcript:seq'), undefined)
})

test('a wake cancelled after admission but before send releases only its Prime charge', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}) })
  const { storage, head } = wakeHead({ ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: MODEL })
  const cancel = new AbortController()
  head.broadcast = async event => { if (event?.type === 'transcript:append') cancel.abort(new Error('Fixture cancelled')) }
  assert.equal((await head.executeCloudWakeStep({ now: T0, signal: cancel.signal })).status, 'failed')
  assert.equal(calls, 0)
  const row = await spend(storage)
  assert.deepEqual([row.dayMicros, row.monthMicros, row.open], [0, 0, {}])
  assert.equal((await storage.get('provider-budget:v1:prime')).requests, 1)
})

async function workerFixture(t, env) {
  const headStorage = memoryStorage(), mirrorStorage = memoryStorage()
  const base = { PUBLIC_HOST: new URL(ORIGIN).host, ACCESS_TEAM: 'fixture.cloudflareaccess.com', ACCESS_AUD: 'fixture-audience', OWNER_EMAIL: 'fixture@example.invalid', ...BUDGET, ...env }
  const upstream = []
  const logs = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, level, (...args) => { logs.push(args.map(String).join(' ')) })
  let reply = () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const head = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, base, { networkFetch: async (url, init) => { upstream.push({ url, headers: new Headers(init.headers) }); return reply() } })
  const mirror = new MirrorDO({ storage: mirrorStorage })
  for (const name of ['HEAD', 'MIRROR']) base[name] = { idFromName: value => value, get: () => ({ fetch: request => (name === 'HEAD' ? head : mirror).fetch(request) }) }
  base.ASSETS = { fetch: () => new Response('Fixture asset') }
  const worker = createWorker({ verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token', networkFetch: async () => { throw new Error('Worker network is forbidden in this fixture') } })
  const request = (pathname, value) => worker.fetch(new Request(ORIGIN + pathname, { method: value === undefined ? 'GET' : 'POST',
    headers: { cookie: 'CF_Authorization=fixture-token', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), base)
  const code = 'export default { fixture: true }', sha = await digest(code)
  const ball = { version: 'x6.1-ball/v1', parentBallId: null, epoch: 1, entries: { 'organ.fixture': { id: 'organ.fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } }, modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } } }
  ball.ballId = await manifestId(ball)
  const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
  assert.equal(typeof canonicalBootstrap, 'function')
  for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) assert.equal((await request('/_bootstrap', input)).status, 200)
  t.after(async () => { await headStorage.idle(); await mirrorStorage.idle(); await mirror.queue })
  return { env: base, request, headStorage, upstream, logs, setReply: value => { reply = value } }
}

const chat = { model: 'deepseek/deepseek-v4-flash', max_tokens: 400, stream: true, messages: [{ role: 'user', content: 'Synthetic only' }] }

test('the browser door: dispatched under the caps, refused over them with window and retryAt, named when a setting is absent', async t => {
  const cloud = await workerFixture(t, { ...PRIME, PRIME_DAILY_CAP_USD: '0.01' })
  const health = await (await cloud.request('/api/health')).json()
  assert.equal(health.capabilities.providerDoors.prime, true)
  assert.equal((await (await cloud.request('/_host/selftest')).json()).providerDoors.prime, true)
  const ok = await cloud.request('/door/prime/v1/chat/completions', chat)
  assert.equal(ok.status, 200)
  assert.match(await ok.text(), /"hi"/)
  assert.equal(cloud.upstream.length, 1)
  assert.equal(cloud.upstream[0].url, 'https://api.pinference.ai/api/v1/chat/completions')
  assert.equal(cloud.upstream[0].headers.get('authorization'), `Bearer ${MARKER}`)
  // The streamed answer keeps its estimate (the edge passes the stream through unread).
  const reserved = providerRequestReservation(new TextEncoder().encode(JSON.stringify(chat)), providerBudgetLimits(cloud.env), '/v1/chat/completions')
  const estimate = (reserved.tokens - 400) * 2 + 400 * 10
  assert.equal((await spend(cloud.headStorage)).dayMicros, estimate)
  const refused = await cloud.request('/door/prime/v1/chat/completions', chat)
  assert.equal(refused.status, 429)
  assert.deepEqual(await refused.json(), { ok: false, code: 'SPEND_CAP_EXCEEDED', provider: 'prime', window: 'day', retryAt: Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z') + 86400000 })
  assert.equal(cloud.upstream.length, 1)
  delete cloud.env.PRIME_MONTHLY_CAP_USD
  const unconfigured = await cloud.request('/door/prime/v1/chat/completions', chat)
  assert.equal(unconfigured.status, 503)
  assert.deepEqual(await unconfigured.json(), { ok: false, code: 'PRIME_NOT_CONFIGURED', provider: 'prime', missing: 'PRIME_MONTHLY_CAP_USD' })
  assert.equal((await (await cloud.request('/api/health')).json()).capabilities.providerDoors.prime, false)
  assert.equal((await (await cloud.request('/_host/selftest')).json()).providerDoors.prime, false)
  delete cloud.env.PRIME_API_KEY
  assert.deepEqual(await (await cloud.request('/door/prime/v1/chat/completions', chat)).json(), { ok: false, code: 'PRIME_NOT_CONFIGURED', provider: 'prime', missing: 'PRIME_API_KEY' })
  assert.equal(cloud.upstream.length, 1)
})

test('the key never appears in any answer, refusal, stored row, journal or log line of the door or the wake', async t => {
  const cloud = await workerFixture(t, { ...PRIME, PRIME_DAILY_CAP_USD: '0.01' })
  cloud.setReply(() => new Response(JSON.stringify({ error: { message: 'upstream refused' } }), { status: 401, headers: { 'content-type': 'application/json' } }))
  const answers = []
  const record = async response => { answers.push(String(response.status), JSON.stringify([...response.headers]), await response.text()) }
  await record(await cloud.request('/door/prime/v1/chat/completions', chat))
  await record(await cloud.request('/door/prime/v1/chat/completions', chat)) // over the day cap
  await record(await cloud.request('/door/prime/v1/models'))
  await record(await cloud.request('/api/health'))
  await record(await cloud.request('/_host/selftest'))
  cloud.env.PRIME_PRICE_IN_PER_M_USD = '1e3'
  await record(await cloud.request('/door/prime/v1/chat/completions', chat)) // malformed setting
  assert.ok(answers.some(text => text.includes('SPEND_CAP_EXCEEDED')))
  assert.ok(answers.some(text => text.includes('PRIME_NOT_CONFIGURED')))
  for (const text of answers) assert.equal(text.includes(MARKER), false, text.slice(0, 200))
  assert.equal(JSON.stringify([...cloud.headStorage.snapshot()]).includes(MARKER), false)
  // The wake: success, then refused over its cap; transcript, journal and spend rows are all in storage.
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'Continuity reviewed without claiming acceptance.' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
  const wake = wakeHead({ ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: 'deepseek/deepseek-v4-flash' })
  const results = [await wake.head.executeCloudWakeStep({ now: T0 })]
  const cappedWake = wakeHead({ ...PRIME, PRIME_MONTHLY_CAP_USD: '0', CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: 'deepseek/deepseek-v4-flash' })
  results.push(await cappedWake.head.executeCloudWakeStep({ now: T0 }))
  for (const value of [results, [...wake.storage.snapshot()], [...cappedWake.storage.snapshot()], cloud.logs]) assert.equal(JSON.stringify(value).includes(MARKER), false)
})

// ---- review follow-up (fix(day4/prime1): review) ----

test('only a listed model priced at or below the set prices is admitted; a dearer or unknown one is refused by name and writes nothing', async () => {
  const storage = memoryStorage(), env = { ...BUDGET, ...PRIME }
  for (const model of ['openai/gpt-6-astra', 'anthropic/claude-opus-5.5', 'anthropic/claude-fable-5.2', 'fixture/unknown-model']) {
    await assert.rejects(reserve(storage, env, T0, { model }), { code: 'PRIME_MODEL_NOT_ALLOWED', status: 403, model })
  }
  assert.deepEqual(storage.snapshot(), new Map())
  // The committed prices ($2 in, $10 out per million) admit exactly the listed models priced at or below them.
  const settings = primeSettings(PRIME)
  for (const [model, [priceIn, priceOut]] of Object.entries(PRIME_MODEL_PRICES)) {
    assert.equal(primeModelAllowed(settings, model), priceIn <= 2000000 && priceOut <= 10000000, model)
  }
  assert.equal(primeModelAllowed(settings, MODEL), true)
  assert.equal(primeModelAllowed(settings, 'openai/gpt-6-astra'), false)
  assert.equal(primeModelAllowed({ ok: false, missing: 'PRIME_API_KEY' }, MODEL), false)
  // Raising the set prices to a dear model's own admits it, and the estimate then covers its list price.
  const dear = { ...BUDGET, ...PRIME, PRIME_PRICE_IN_PER_M_USD: '10', PRIME_PRICE_OUT_PER_M_USD: '50' }
  assert.equal((await reserve(storage, dear, T0, { model: 'openai/gpt-6-astra' })).spend.estimateMicroUsd, 600 * 10 + 400 * 50)
  // The model listing names no model and reserves nothing; any other prime reservation must name its model.
  const limits = providerBudgetLimits(env)
  assert.equal((await reserveProviderBudget(storage, { provider: 'prime', tokens: 0, outputTokens: 0, model: null }, limits, T0)).spend.estimateMicroUsd, 0)
  await assert.rejects(reserveProviderBudget(storage, { provider: 'prime', tokens: 10, outputTokens: 1, model: null }, limits, T0), { code: 'PROVIDER_BUDGET_REQUEST_INVALID' })
  await assert.rejects(reserveProviderBudget(storage, { provider: 'prime', tokens: 10, outputTokens: 1 }, limits, T0), { code: 'PROVIDER_BUDGET_REQUEST_INVALID' })
  await assert.rejects(reserveProviderBudget(storage, { provider: 'prime', tokens: 10, outputTokens: 1, model: 'x'.repeat(201) }, limits, T0), { code: 'PROVIDER_BUDGET_REQUEST_INVALID' })
})

test('the browser door refuses a dearer model with PRIME_MODEL_NOT_ALLOWED before any call, and still lists models', async t => {
  const cloud = await workerFixture(t, PRIME)
  const refused = await cloud.request('/door/prime/v1/chat/completions', { ...chat, model: 'openai/gpt-6-astra', max_tokens: 4096 })
  assert.equal(refused.status, 403)
  assert.deepEqual(await refused.json(), { ok: false, code: 'PRIME_MODEL_NOT_ALLOWED', provider: 'prime', model: 'openai/gpt-6-astra' })
  assert.equal(cloud.upstream.length, 0)
  assert.equal(await spend(cloud.headStorage), null)
  assert.equal((await cloud.request('/door/prime/v1/models')).status, 200)
  assert.equal(cloud.upstream.length, 1)
})

test('the wake pick and /api/health cloudWake count prime only with all five settings and an admitted model', async t => {
  const env = { ...PRIME, CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: MODEL }
  assert.deepEqual(cloudWakeProvider(env), { ok: true, provider: 'prime' })
  assert.deepEqual(cloudWakeProvider({ ...env, PRIME_MONTHLY_CAP_USD: '150.' }), { ok: false, code: 'PRIME_NOT_CONFIGURED', missing: 'PRIME_MONTHLY_CAP_USD' })
  assert.deepEqual(cloudWakeProvider({ ...env, CLOUD_MODEL_PRIME: 'openai/gpt-6-astra' }), { ok: false, code: 'PRIME_MODEL_NOT_ALLOWED', model: 'openai/gpt-6-astra' })
  const cloud = await workerFixture(t, { ...env, WAKE_EXECUTOR_ENABLED: '1', PRIME_MONTHLY_CAP_USD: '150.' })
  assert.equal((await (await cloud.request('/api/health')).json()).capabilities.cloudWake, false)
  cloud.env.PRIME_MONTHLY_CAP_USD = '150'
  assert.equal((await (await cloud.request('/api/health')).json()).capabilities.cloudWake, true)
  cloud.env.CLOUD_MODEL_PRIME = 'openai/gpt-6-astra'
  assert.equal((await (await cloud.request('/api/health')).json()).capabilities.cloudWake, false)
  // The wake step names the refusal and calls nothing.
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}) })
  const { head, storage } = wakeHead({ ...env, PRIME_MONTHLY_CAP_USD: '150.' })
  assert.deepEqual(await head.executeCloudWakeStep({ now: T0 }), { status: 'failed', reason: 'prime_not_configured', missing: 'PRIME_MONTHLY_CAP_USD', cause: 'provider_setting_missing' })
  assert.deepEqual((await storage.get('head:wish:active')).steps, [{ step: 1, at: T0, outcome: 'failed', reason: 'prime_not_configured', missing: 'PRIME_MONTHLY_CAP_USD' }])
  assert.equal(calls, 0)
})

test('a wake over its cap answers spend_cap_exceeded with window and retryAt, and logs it in the wish', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}) })
  const { head, storage } = wakeHead({ ...PRIME, PRIME_DAILY_CAP_USD: '0.001', CLOUD_WAKE_PROVIDER: 'prime', CLOUD_MODEL_PRIME: MODEL })
  assert.deepEqual(await head.executeCloudWakeStep({ now: T0 }), { status: 'failed', reason: 'spend_cap_exceeded', window: 'day', retryAt: NEXT_DAY, cause: 'budget_reached', budget: 'prime_spend_day' })
  const wish = await storage.get('head:wish:active')
  assert.deepEqual(wish.steps, [{ step: 1, at: T0, outcome: 'failed', reason: 'spend_cap_exceeded', window: 'day', retryAt: NEXT_DAY }])
  assert.equal(wish.stepsCompleted, 0)
  assert.equal(calls, 0)
  assert.equal(await spend(storage), null)
})
