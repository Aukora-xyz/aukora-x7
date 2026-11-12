/**
 * The provider rule through the PRODUCTION wake entry, `executeCloudWakeStep`
 * in head-do.mjs, not only the helper. An unknown CLOUD_WAKE_PROVIDER is refused before any dispatch; a named provider
 * is never swapped for another account; an absent setting keeps the legacy order.
 *
 * INTEGRATION TEST: it needs head-do.mjs wired to cloud-wake-tools.mjs.
 * On a branch without it, whose head-do.mjs is untouched baseline, the first three cases fail by design (the baseline wake
 * picks DeepSeek whatever the setting says); they pass on the integration of both branches. Synthetic storage and
 * transport only; no live provider is ever called.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject } from '../head-do.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)

function fixtureStorage(initial = []) {
  let rows = new Map(initial), tail = Promise.resolve()
  const view = data => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async key => data.delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
  })
  const storage = Object.fromEntries(['get', 'put', 'delete', 'list'].map(key => [key, (...args) => view(rows)[key](...args)]))
  storage.transaction = operation => {
    const next = tail.then(async () => { const copy = structuredClone(rows); const result = await operation(view(copy)); rows = copy; return result })
    tail = next.catch(() => {})
    return next
  }
  return { storage }
}

function wake(t, env) {
  const hs = fixtureStorage([
    ['bootstrap:v1', { phase: 'complete', seedId: SEED }],
    ['head:current', { ballId: BALL, epoch: 2, entries: { organ: {} } }],
    ['head:wish:active', { wish_id: 'fixture-wish', intent: 'Inspect continuity', acceptance: 'Record observed facts', status: 'running', stepsCompleted: 0, maxSteps: 6 }],
  ])
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => [] }, {
    WAKE_EXECUTOR_ENABLED: '1', PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '20', PROVIDER_BUDGET_TOKENS: '1000000', PROVIDER_MAX_OUTPUT_TOKENS: '4096', ...env })
  head.broadcast = async () => {}
  const urls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url))
    if (String(url).startsWith('https://api.anthropic.com/')) {
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Continuity reviewed without claiming acceptance.' }] })
    }
    return Response.json({ choices: [{ message: { content: 'Continuity reviewed without claiming acceptance.' } }] })
  })
  return { urls, run: () => head.executeCloudWakeStep({ now: 1000000 }) }
}

test('an unknown CLOUD_WAKE_PROVIDER is refused at the wake entry, with no dispatch to any provider', async t => {
  const w = wake(t, { CLOUD_WAKE_PROVIDER: 'anthropicc', DEEPSEEK_API_KEY: 'synthetic-deepseek', ANTHROPIC_API_KEY: 'synthetic-anthropic' })
  assert.deepEqual(await w.run(), { status: 'failed', reason: 'provider_unavailable' })
  assert.deepEqual(w.urls, [])
})

test('a named provider without its secret is refused, never swapped for a configured one', async t => {
  const w = wake(t, { CLOUD_WAKE_PROVIDER: 'openrouter', DEEPSEEK_API_KEY: 'synthetic-deepseek' })
  assert.deepEqual(await w.run(), { status: 'failed', reason: 'provider_unavailable' })
  assert.deepEqual(w.urls, [])
})

test('a named provider with its secret is the one dispatched to', async t => {
  const w = wake(t, { CLOUD_WAKE_PROVIDER: 'anthropic', DEEPSEEK_API_KEY: 'synthetic-deepseek', ANTHROPIC_API_KEY: 'synthetic-anthropic' })
  assert.equal((await w.run()).status, 'success')
  assert.deepEqual(w.urls, ['https://api.anthropic.com/v1/messages'])
})

test('an absent setting keeps the legacy order: DeepSeek first', async t => {
  const w = wake(t, { DEEPSEEK_API_KEY: 'synthetic-deepseek', ANTHROPIC_API_KEY: 'synthetic-anthropic' })
  assert.equal((await w.run()).status, 'success')
  assert.deepEqual(w.urls, ['https://api.deepseek.com/chat/completions'])
})
