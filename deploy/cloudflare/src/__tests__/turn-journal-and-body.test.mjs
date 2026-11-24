/** Pre-model turn journal (before `/door/*` dispatch) and Cloudflare Browser Rendering headless body tests. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorker } from '../worker.mjs'
import { X61HeadDurableObject, canonicalBootstrap, digest, manifestId, BOOTSTRAP_VERSION } from '../head-do.mjs'
import { MirrorDO } from '../mirror-do.mjs'
import { TURN_JOURNAL_SCHEMA } from '../turn-journal.mjs'
import { CLOUD_BODY_SCHEMA } from '../cloud-body.mjs'

const ORIGIN = 'https://x61.example.invalid'

function createMemoryStorage() {
  const data = new Map()
  let alarm = null
  const view = {
    get: async key => (data.has(key) ? structuredClone(data.get(key)) : undefined),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => data.delete(key),
    deleteAll: async () => { data.clear(); alarm = null },
    list: async ({ prefix = '', limit = Infinity } = {}) => {
      const out = new Map()
      for (const [k, v] of [...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (k.startsWith(prefix)) {
          out.set(k, structuredClone(v))
          if (out.size >= limit) break
        }
      }
      return out
    },
    getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at },
    deleteAlarm: async () => { alarm = null },
    transaction: async fn => fn(view),
  }
  return view
}

async function createSeededEdgeFixture({ networkFetch, launchBrowser = null } = {}) {
  const source = 'export const organ = "seed-echo";\n'
  const sha = await digest(source)
  const ballDraft = {
    version: 'x6.1-ball/v1',
    epoch: 167,
    parentBallId: null,
    createdAt: '2026-11-11T00:00:00.000Z',
    authorPeerId: 'auma-live',
    entries: {
      'seed-echo': {
        id: 'seed-echo',
        specifier: `ball:${sha}`,
        disabled: false,
        config: {},
        previousSpecifiers: [],
      },
    },
    modules: {
      [sha]: { sha256: sha, specifier: `ball:${sha}`, size: Buffer.byteLength(source) },
    },
  }
  const ball = { ...ballDraft, ballId: await manifestId(ballDraft) }
  const mirrorEntries = [
    ['/dsh/home/auma', { kind: 'dir', mode: 0o755 }],
    ['/dsh/home/auma/HANDOFF.md', {
      kind: 'file',
      mode: 0o644,
      mtimeMs: 1794350000000,
      b64: Buffer.from('# HANDOFF\n').toString('base64'),
    }],
  ]
  const batchDigest = await digest(canonicalBootstrap(mirrorEntries))
  const seedPayload = {
    version: BOOTSTRAP_VERSION,
    ball,
    codeBySha: { [sha]: source },
    mirror: { entryCount: mirrorEntries.length, batchDigests: [batchDigest] },
  }
  const seedId = await digest(canonicalBootstrap(seedPayload))
  const pkg = { ...seedPayload, seedId }

  const headStorage = createMemoryStorage()
  const mirrorStorage = createMemoryStorage()
  const env = {
    PUBLIC_HOST: 'x61.example.invalid',
    OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: '11'.repeat(32),
    AUMLOK_CUSTODY_PEPPER: '22'.repeat(32),
    ANTHROPIC_API_KEY: 'synthetic-anthropic-key',
    OPENROUTER_API_KEY: 'synthetic-openrouter-key',
    PROVIDER_BUDGET_WINDOW_MS: '60000',
    PROVIDER_BUDGET_REQUESTS: '20',
    PROVIDER_BUDGET_TOKENS: '100000',
    PROVIDER_MAX_OUTPUT_TOKENS: '256',
  }
  const headDo = new X61HeadDurableObject({ storage: headStorage, getWebSockets: () => [] }, env, { networkFetch: networkFetch ?? (() => { throw new Error('No external network in fixture') }) })
  const mirrorDo = new MirrorDO({ storage: mirrorStorage }, env)
  env.HEAD = { idFromName: () => 'node-main-v1', get: () => headDo }
  env.MIRROR = { idFromName: () => 'node-main-v1', get: () => mirrorDo }

  const worker = createWorker({
    verifyAccess: async () => ({ type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }),
    networkFetch,
    launchBrowser,
    now: () => 1794351000000,
  })

  const postBootstrap = body => worker.fetch(new Request(`${ORIGIN}/_bootstrap`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env)
  assert.equal((await postBootstrap({ action: 'prepare', package: pkg })).status, 200)
  assert.equal((await postBootstrap({ action: 'batch', seedId, index: 0, entries: mirrorEntries })).status, 200)
  assert.equal((await postBootstrap({ action: 'commit', seedId })).status, 200)

  return { env, worker, headStorage, ball, seedId }
}

test('C3: pre-model turn journal commits strictly BEFORE networkFetch, survives PROVIDER_OUTCOME_UNKNOWN, enforces turnId conflict detection, and never claims owner-confirmed', async () => {
  let rowObservedDuringNetworkFetch = null
  let shouldThrowUpstream = true

  const fx = await createSeededEdgeFixture({
    networkFetch: async () => {
      rowObservedDuringNetworkFetch = await fx.headStorage.get('head:turn-journal:row:1')
      if (shouldThrowUpstream) {
        throw new Error('Upstream connection dropped mid-flight')
      }
      return Response.json({ id: 'msg_01', content: [{ type: 'text', text: 'ok' }] })
    },
  })

  const promptText = 'Give me a full report on what you did overnight.'
  const payload = {
    model: 'claude-opus-4-1-20250805',
    max_tokens: 64,
    messages: [{ role: 'user', content: promptText }],
  }

  // 1. Upstream throws (422 PROVIDER_OUTCOME_UNKNOWN), yet turn was ALREADY committed before networkFetch!
  const failedDoor = await fx.worker.fetch(new Request(`${ORIGIN}/door/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-x6-turn-id': 'morning-turn-01',
    },
    body: JSON.stringify(payload),
  }), fx.env)
  assert.equal(failedDoor.status, 422)
  assert.ok(rowObservedDuringNetworkFetch !== null, 'Turn journal entry must be durable BEFORE networkFetch starts')
  assert.equal(rowObservedDuringNetworkFetch.utterancePreview, promptText)
  assert.equal(rowObservedDuringNetworkFetch.signerRole, 'owner-session-observed')
  assert.notEqual(rowObservedDuringNetworkFetch.signerRole, 'owner-confirmed')

  const headerMeta = JSON.parse(failedDoor.headers.get('x-x6-turn-journal'))
  assert.equal(headerMeta.savedBeforeInference, true)
  assert.equal(headerMeta.seq, 1)
  assert.equal(headerMeta.turnId, 'morning-turn-01')
  assert.equal(headerMeta.signerRole, 'owner-session-observed')

  // 2. Dispatched turn IDs cannot be replayed, including after an ambiguous outcome.
  shouldThrowUpstream = false
  const replayDoor = await fx.worker.fetch(new Request(`${ORIGIN}/door/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-x6-turn-id': 'morning-turn-01',
    },
    body: JSON.stringify(payload),
  }), fx.env)
  assert.equal(replayDoor.status, 409)
  assert.equal((await replayDoor.json()).code, 'TURN_DISPATCH_ALREADY_STARTED')

  const conflictDoor = await fx.worker.fetch(new Request(`${ORIGIN}/door/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-x6-turn-id': 'morning-turn-01',
    },
    body: JSON.stringify({ ...payload, max_tokens: 32 }),
  }), fx.env)
  assert.equal(conflictDoor.status, 409)
  assert.equal((await conflictDoor.json()).code, 'TURN_JOURNAL_CONFLICT')

  // 3. Read durable journal via GET /_host/turn-journal
  const journalResp = await fx.worker.fetch(new Request(`${ORIGIN}/_host/turn-journal`, {
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
  }), fx.env)
  assert.equal(journalResp.status, 200)
  const journal = await journalResp.json()
  assert.equal(journal.ok, true)
  assert.equal(journal.schema, TURN_JOURNAL_SCHEMA)
  assert.equal(journal.seq, 1)
  assert.equal(journal.entries[0].utterancePreview, promptText)
  assert.equal(journal.entries[0].signerRole, 'owner-session-observed')
})

test('C3: headless cloud-body truthfully reports unbound state, yields to active turns (409 BROWSER_TAB_ACTIVE), and closes Chromium in finally', async () => {
  // 1. Unbound env.BROWSER -> headlessBrowserBody: false, 'no-tab-agent-loop' in unsupported, 503 on run
  const unbound = await createSeededEdgeFixture()
  const healthUnbound = await (await unbound.worker.fetch(new Request(`${ORIGIN}/api/health`), unbound.env)).json()
  assert.equal(healthUnbound.capabilities.savedBeforeInference, true)
  assert.equal(healthUnbound.capabilities.headlessBrowserBody, false)
  assert.equal(healthUnbound.unsupported.includes('no-tab-agent-loop'), true)

  const runUnbound = await unbound.worker.fetch(new Request(`${ORIGIN}/_host/cloud-body`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'run' }),
  }), unbound.env)
  assert.equal(runUnbound.status, 503)
  assert.equal((await runUnbound.json()).code, 'CLOUD_BROWSER_BINDING_MISSING')

  // 2. Bound browser launcher -> yields when an active turn is running, runs when idle, and closes in finally even on error
  let launchCount = 0
  let closeCount = 0
  let simulateGotoFailure = false

  const bound = await createSeededEdgeFixture()
  bound.env.BROWSER = {
    async launch() {
      launchCount++
      return {
        async newPage() {
          return {
            async goto(url) {
              assert.equal(url, `${ORIGIN}/preview.html`)
              if (simulateGotoFailure) throw new Error('Headless navigation failed')
            },
            async waitForTimeout() {},
            async title() { return 'Aukora X6.1' },
          }
        },
        async close() {
          closeCount++
        },
      }
    },
  }

  const healthBound = await (await bound.worker.fetch(new Request(`${ORIGIN}/api/health`), bound.env)).json()
  assert.equal(healthBound.capabilities.headlessBrowserBody, true)
  assert.equal(healthBound.unsupported.includes('no-tab-agent-loop'), false)

  // Start an active turn in HeadDO -> cloud-body MUST yield (409 BROWSER_TAB_ACTIVE) without launching browser
  const startTurn = await bound.worker.fetch(new Request(`${ORIGIN}/_head/transcript`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'turn_start', turn_id: 'live-tab-turn', tab_id: 'tab-owner-1' }),
  }), bound.env)
  assert.equal(startTurn.status, 200)
  const startTurnBody = await startTurn.json()

  const yielded = await bound.worker.fetch(new Request(`${ORIGIN}/_host/cloud-body`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'run', holdMs: 250 }),
  }), bound.env)
  assert.equal(yielded.status, 409)
  assert.equal((await yielded.json()).code, 'BROWSER_TAB_ACTIVE')
  assert.equal(launchCount, 0)

  // Finish the active turn -> cloud-body runs and closes cleanly
  await bound.worker.fetch(new Request(`${ORIGIN}/_head/transcript`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'turn_complete', turn_id: 'live-tab-turn', tab_id: 'tab-owner-1', leaseToken: startTurnBody.leaseToken }),
  }), bound.env)

  const ran = await bound.worker.fetch(new Request(`${ORIGIN}/_host/cloud-body`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'run', holdMs: 250 }),
  }), bound.env)
  assert.equal(ran.status, 200)
  const ranBody = await ran.json()
  assert.equal(ranBody.ok, true)
  assert.equal(ranBody.schema, CLOUD_BODY_SCHEMA)
  assert.equal(ranBody.mounted, true)
  assert.equal(ranBody.pageTitle, 'Aukora X6.1')
  assert.equal(ranBody.browserClosed, true)
  assert.equal(launchCount, 1)
  assert.equal(closeCount, 1)

  // Even when page.goto throws, browser.close() MUST still run in finally!
  simulateGotoFailure = true
  const crashed = await bound.worker.fetch(new Request(`${ORIGIN}/_host/cloud-body`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'run', holdMs: 250 }),
  }), bound.env)
  assert.equal(crashed.status, 503)
  assert.equal(launchCount, 2)
  assert.equal(closeCount, 2)
})

test('separate Worker requests cancel the HeadDO-owned upstream stream and fence replay', async () => {
  let upstreamSignal, streamCancelled = 0, calls = 0
  const fx = await createSeededEdgeFixture({ networkFetch: async (_url, init) => {
    calls++
    upstreamSignal = init.signal
    return new Response(new ReadableStream({ cancel() { streamCancelled++ } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  const headers = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-x6-turn-id': 'cross-worker-turn' }
  const payload = JSON.stringify({ model: 'fixture', max_tokens: 32, messages: [{ role: 'user', content: 'stream test' }] })
  const door = () => new Request(`${ORIGIN}/door/anthropic/v1/messages`, { method: 'POST', headers, body: payload })
  const response = await fx.worker.fetch(door(), fx.env)
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  const pending = reader.read()
  // The second Worker has no reference to the first Worker or its transport.
  const secondWorker = createWorker({ verifyAccess: async () => true, networkFetch: () => assert.fail('Cancellation must not dispatch from Worker') })
  const cancelled = await secondWorker.fetch(new Request(`${ORIGIN}/_host/voice`, {
    method: 'POST', headers, body: JSON.stringify({ action: 'barge_in', turnId: 'cross-worker-turn' }),
  }), fx.env)
  assert.equal(cancelled.status, 200)
  assert.equal(upstreamSignal.aborted, true)
  await assert.rejects(pending, /TURN_CANCELLED/)
  assert.equal(streamCancelled, 1)
  assert.equal((await secondWorker.fetch(door(), fx.env)).status, 409)
  assert.equal(calls, 1)
})


function parentDoor(id, { parent = 'consult-parent', signal } = {}) {
  return new Request(`${ORIGIN}/door/anthropic/v1/messages`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-x6-turn-id': parent, 'x-x6-request-id': id },
    body: JSON.stringify({ model: 'fixture', max_tokens: 32, messages: [{ role: 'user', content: 'consult' }] }),
    signal,
  })
}

test('Worker maps parent and request IDs separately and parent barge-in aborts all consult streams', async () => {
  const signals = []
  let cancelledStreams = 0
  const fx = await createSeededEdgeFixture({ networkFetch: async (_url, init) => {
    signals.push(init.signal)
    assert.equal(init.headers.get('x-x6-turn-id'), null)
    assert.equal(init.headers.get('x-x6-parent-turn-id'), null)
    assert.equal(init.headers.get('x-x6-request-id'), null)
    return new Response(new ReadableStream({ cancel() { cancelledStreams++ } }))
  } })
  await fx.headStorage.put('head:turn:active', { turn_id: 'consult-parent', tab_id: 'fixture-tab', status: 'running', heartbeat_at: Date.now() })
  const responses = []
  for (const id of ['consult-1', 'consult-2']) {
    const response = await fx.worker.fetch(parentDoor(id), fx.env)
    assert.equal(response.status, 200)
    const meta = JSON.parse(response.headers.get('x-x6-turn-journal'))
    assert.equal(meta.turnId, id)
    assert.equal(meta.parentTurnId, 'consult-parent')
    const index = await fx.headStorage.get(`head:turn-journal:turn:${id}`)
    assert.equal(index.parentTurnId, 'consult-parent')
    assert.equal((await fx.headStorage.get(`head:turn-journal:row:${index.seq}`)).parentTurnId, 'consult-parent')
    responses.push(response)
  }
  const reads = responses.map(response => assert.rejects(response.body.getReader().read(), /TURN_CANCELLED/))
  const secondWorker = createWorker({ verifyAccess: async () => true, networkFetch: () => assert.fail('Worker must not own provider transport') })
  const cancelled = await secondWorker.fetch(new Request(`${ORIGIN}/_host/voice`, {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'barge_in', turnId: 'consult-parent' }),
  }), fx.env)
  assert.equal(cancelled.status, 200)
  await Promise.all(reads)
  assert.deepEqual(signals.map(signal => signal.aborted), [true, true])
  assert.equal(cancelledStreams, 2)
  await fx.headStorage.put('head:turn:active', { turn_id: 'new-parent', status: 'running', heartbeat_at: Date.now() })
  const late = await secondWorker.fetch(parentDoor('late-consult'), fx.env)
  assert.equal(late.status, 409)
  assert.equal((await late.json()).code, 'TURN_CANCELLED')
  assert.equal(signals.length, 2)
})

test('Worker forwards client abort and does not infer parent identity for legacy requests', async () => {
  const signals = []
  const fx = await createSeededEdgeFixture({ networkFetch: async (_url, init) => {
    signals.push(init.signal)
    return new Response(new ReadableStream())
  } })
  await fx.headStorage.put('head:turn:active', { turn_id: 'consult-parent', status: 'running', heartbeat_at: Date.now() })
  const controller = new AbortController()
  const response = await fx.worker.fetch(parentDoor('client-cancelled', { signal: controller.signal }), fx.env)
  assert.equal(response.status, 200)
  const rejected = assert.rejects(response.body.getReader().read(), /TURN_CANCELLED/)
  controller.abort()
  await rejected
  assert.equal(signals[0].aborted, true)
  const legacy = parentDoor('discarded')
  legacy.headers.delete('x-x6-request-id')
  legacy.headers.set('x-x6-turn-id', 'legacy-request')
  legacy.headers.set('x-x6-parent-turn-id', 'injected-parent')
  const legacyResponse = await fx.worker.fetch(legacy, fx.env)
  assert.equal(legacyResponse.status, 200)
  assert.equal(JSON.parse(legacyResponse.headers.get('x-x6-turn-journal')).parentTurnId, null)
  await legacyResponse.body.cancel()
  const missingParent = parentDoor('orphan-request')
  missingParent.headers.delete('x-x6-turn-id')
  const rejectedParent = await fx.worker.fetch(missingParent, fx.env)
  assert.equal(rejectedParent.status, 400)
  assert.equal((await rejectedParent.json()).code, 'TURN_JOURNAL_PARENT_ID_REQUIRED')
  assert.equal(signals.length, 2)
})
