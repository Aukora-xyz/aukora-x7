/**
 * Prime budget regression tests:
 * - RT-PRIME-1: $0 GET /door/prime/v1/models reservations never pollute row.open or evict in-flight charges.
 * - RT-PRIME-2: pre-dispatch 503 BOOTSTRAP_REQUIRED on /_head/provider-dispatch releases Prime spend reservations.
 * - clone-before-mutate: SPEND_CAP_EXCEEDED or failed tx.put never mutates caller/adapter records in place.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, bootstrapPackage, digest, manifestId } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import {
  PRIME_OPEN_CHARGES_MAX,
  PRIME_SPEND_KEY,
  providerBudgetLimits,
  providerBudgetRecordStorage,
  reserveProviderBudget,
  settlePrimeSpend,
} from '../provider-budget.mjs'

const ORIGIN = 'https://prime-repair.example.invalid'
const OWNER = 'owner@example.invalid'
const BUDGET = {
  PROVIDER_BUDGET_WINDOW_MS: '60000',
  PROVIDER_BUDGET_REQUESTS: '1000',
  PROVIDER_BUDGET_TOKENS: '1000000',
  PROVIDER_MAX_OUTPUT_TOKENS: '4096',
}
const PRIME = {
  PRIME_API_KEY: 'prime-synthetic-key-00000000',
  PRIME_DAILY_CAP_USD: '10',
  PRIME_MONTHLY_CAP_USD: '150',
  PRIME_PRICE_IN_PER_M_USD: '2',
  PRIME_PRICE_OUT_PER_M_USD: '10',
}
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)

function memoryStorage(initial = []) {
  let rows = new Map(initial), tail = Promise.resolve()
  const view = data => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity, reverse = false } = {}) => {
      const entries = [...data].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
      if (reverse) entries.reverse()
      return new Map(entries.slice(0, limit).map(([key, value]) => [key, structuredClone(value)]))
    },
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm'].map(key => [key, (...args) => view(rows)[key](...args)]))
  storage.transaction = operation => {
    const next = tail.then(async () => { const copy = structuredClone(rows); const result = await operation(view(copy)); rows = copy; return result })
    tail = next.catch(() => {})
    return next
  }
  storage.setRaw = (key, value) => { rows.set(key, structuredClone(value)) }
  storage.idle = () => tail
  return storage
}

test('RT-PRIME-1: zero-cost GET /door/prime/v1/models reservations never insert into row.open or evict in-flight charges', async () => {
  const storage = memoryStorage()
  const limits = providerBudgetLimits({ ...BUDGET, ...PRIME })
  const initialList = await reserveProviderBudget(storage, { provider: 'prime', tokens: 0, outputTokens: 0, model: null }, limits, T0)
  assert.equal(initialList.spend.chargeId, null)
  assert.equal(initialList.spend.estimateMicroUsd, 0)
  assert.equal(await storage.get(PRIME_SPEND_KEY), undefined)

  const wakeCharge = await reserveProviderBudget(
    storage,
    { provider: 'prime', tokens: 1000, outputTokens: 400, model: 'deepseek/deepseek-v4-flash' },
    limits,
    T0,
  )
  assert.equal(wakeCharge.spend.estimateMicroUsd, 5200)

  for (let i = 0; i < PRIME_OPEN_CHARGES_MAX + 10; i++) {
    const listRes = await reserveProviderBudget(storage, { provider: 'prime', tokens: 0, outputTokens: 0, model: null }, limits, T0 + i + 1)
    assert.equal(listRes.spend.chargeId, null)
  }

  const rowBeforeSettle = await storage.get(PRIME_SPEND_KEY)
  assert.deepEqual(Object.keys(rowBeforeSettle.open), [wakeCharge.spend.chargeId])

  const settled = await settlePrimeSpend(storage, wakeCharge.spend.chargeId, { inputUnits: 100, outputUnits: 20 })
  assert.equal(settled.settled, true)
  assert.equal((await storage.get(PRIME_SPEND_KEY)).dayMicros, 400)
})

test('RT-PRIME-2: Prime browser call refused BOOTSTRAP_REQUIRED (seed rotation or prepared phase) releases its spend charge', async t => {
  for (const nextBootstrap of [
    { phase: 'complete', seedId: 'f'.repeat(64) },
    { phase: 'prepared', seedId: 'e'.repeat(64) },
  ]) {
    const headStorage = memoryStorage(), mirrorStorage = memoryStorage()
    const env = {
      PUBLIC_HOST: new URL(ORIGIN).host,
      ACCESS_TEAM: 'fixture.cloudflareaccess.com',
      ACCESS_AUD: 'fixture-audience',
      OWNER_EMAIL: OWNER,
      ...BUDGET,
      ...PRIME,
    }
    let upstreamCalls = 0
    const head = new X61HeadDurableObject(
      { storage: headStorage, getWebSockets: () => [] },
      env,
      { networkFetch: async () => { upstreamCalls++; return new Response('ok') } },
    )
    const mirror = new MirrorDO({ storage: mirrorStorage })
    let mutated = false
    env.HEAD = {
      idFromName: value => value,
      get: () => ({
        fetch: async request => {
          const url = new URL(request.url)
          if (url.pathname === '/_head/provider-dispatch' && !mutated) {
            mutated = true
            headStorage.setRaw('bootstrap:v1', nextBootstrap)
          }
          return head.fetch(request)
        },
      }),
    }
    env.MIRROR = { idFromName: value => value, get: () => ({ fetch: request => mirror.fetch(request) }) }
    env.ASSETS = { fetch: () => new Response('asset') }
    const worker = createWorker({
      verifyAccess: async request => request.headers.get('cookie') === 'CF_Authorization=fixture-token',
      networkFetch: async () => { throw new Error('Worker network forbidden') },
    })
    const call = (pathname, value) => worker.fetch(new Request(ORIGIN + pathname, {
      method: value === undefined ? 'GET' : 'POST',
      headers: { cookie: 'CF_Authorization=fixture-token', origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }), env)

    const code = 'export default { fixture: true }', sha = await digest(code)
    const ball = {
      version: 'x6.1-ball/v1',
      parentBallId: null,
      epoch: 1,
      entries: { 'organ.fixture': { id: 'organ.fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [] } },
      modules: { [sha]: { sha256: sha, specifier: `ball:${sha}` } },
    }
    ball.ballId = await manifestId(ball)
    const seed = await bootstrapPackage({ version: 'x61-bootstrap/v1', ball, codeBySha: { [sha]: code }, mirror: { entryCount: 0, batchDigests: [] } })
    for (const input of [{ action: 'prepare', package: seed }, { action: 'commit', seedId: seed.seedId }]) {
      assert.equal((await call('/_bootstrap', input)).status, 200)
    }
    t.after(async () => { await headStorage.idle(); await mirrorStorage.idle(); await mirror.queue })

    const res = await call('/door/prime/v1/chat/completions', {
      model: 'deepseek/deepseek-v4-flash',
      max_tokens: 400,
      stream: true,
      messages: [{ role: 'user', content: 'Synthetic only' }],
    })
    assert.equal(res.status, 503)
    assert.equal(upstreamCalls, 0)
    const spendRow = await headStorage.get(PRIME_SPEND_KEY)
    assert.equal(spendRow.dayMicros, 0)
    assert.deepEqual(spendRow.open, {})
  }
})

test('clone-before-mutate: SPEND_CAP_EXCEEDED and failed tx.put leave non-cloning reference storage untouched', async () => {
  // Single-record adapter that returns live object references without structuredClone.
  let record
  let failNextPut = false
  const rawSingleRecord = {
    transaction: async operation => operation({
      get: async key => { assert.equal(key, 'budget-record'); return record },
      put: async (key, value) => {
        assert.equal(key, 'budget-record')
        if (failNextPut) throw Object.assign(new Error('IO_WRITE_FAILED'), { code: 'IO_WRITE_FAILED' })
        record = value
      },
    }),
  }
  const adapted = providerBudgetRecordStorage(rawSingleRecord, 'budget-record')
  const limits = providerBudgetLimits({ ...BUDGET, ...PRIME, PRIME_DAILY_CAP_USD: '0.01' })

  const first = await reserveProviderBudget(
    adapted,
    { provider: 'prime', tokens: 1000, outputTokens: 400, model: 'deepseek/deepseek-v4-flash' },
    limits,
    T0,
  )
  const snapshotAfterFirst = structuredClone(record)
  assert.equal(snapshotAfterFirst['provider-budget:v1:prime'].requests, 1)
  assert.equal(snapshotAfterFirst[PRIME_SPEND_KEY].dayMicros, 5200)

  // Over-cap refusal must NOT increment requests/tokens on the live reference in `record`.
  await assert.rejects(
    reserveProviderBudget(
      adapted,
      { provider: 'prime', tokens: 1000, outputTokens: 400, model: 'deepseek/deepseek-v4-flash' },
      limits,
      T0 + 1,
    ),
    { code: 'SPEND_CAP_EXCEEDED' },
  )
  assert.deepEqual(record, snapshotAfterFirst)

  // Failed tx.put during settlePrimeSpend must NOT delete chargeId or lower dayMicros on `record`.
  failNextPut = true
  await assert.rejects(
    settlePrimeSpend(adapted, first.spend.chargeId, { inputUnits: 100, outputUnits: 20 }),
    { code: 'IO_WRITE_FAILED' },
  )
  assert.deepEqual(record, snapshotAfterFirst)
})
