/** Synthetic storage and transport only. Never call live providers or inspect user data. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, CLOUD_WAKE_PATHS, CLOUD_WAKE_CHECKPOINT_PATH, CLOUD_WAKE_LIMITS, cloudWakeTextSafe } from '../head-do.mjs'
import { MirrorDO, mirrorDigest, readMirrorWakeText, appendMirrorWakeCheckpoint, publishMirror } from '../mirror-do.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64), ID = 'c'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const PREFIX = 'mirror:v2:', FENCE = PREFIX + 'global-fence'

function fixtureStorage(initial = []) {
  let rows = new Map(initial), tail = Promise.resolve()
  const reads = []
  const view = data => ({
    get: async key => { reads.push(key); return structuredClone(data.get(key)) },
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
  return { storage, reads, snapshot: () => structuredClone(rows) }
}

async function mirrorFixture(text = 'Continuity epoch 2') {
  const f = fixtureStorage([['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1,
    ballId: BALL, epoch: 2, batchDigests: [ID], nextBatch: 1, entryCount: 1, expectedEntries: 1 }], [FENCE, { lineageId: LINEAGE, revision: 1 }]])
  const path = CLOUD_WAKE_PATHS[0], key = await mirrorDigest(path), bytes = new TextEncoder().encode(text)
  const b64 = btoa(String.fromCharCode(...bytes))
  await f.storage.put(PREFIX + 'entry:' + key, { path, kind: 'file', mode: 0o600, mtimeMs: 1, bytes: bytes.length, chunks: b64 ? 1 : 0 })
  if (b64) await f.storage.put(PREFIX + 'chunk:' + key + ':0', b64)
  return f
}

const checkpoint = () => ({ id: ID, at: 1000, head: { ballId: BALL, epoch: 2 }, evidence: [{ tool: 'inspectHeadWish', digest: 'd'.repeat(64) }] })

async function wakeFixture(t, answers, override = {}) {
  const hs = fixtureStorage([
    ['bootstrap:v1', { phase: 'complete', seedId: SEED }],
    ['head:current', { ballId: BALL, epoch: 2, entries: { organ: {} } }],
    ['head:wish:active', { wish_id: 'fixture-wish', intent: 'Inspect continuity', acceptance: 'Record observed facts', status: 'running', stepsCompleted: 0, maxSteps: 6 }],
    ['head:transcript:seq', 1], ['head:transcript:row:1', { role: 'user', content: 'PRIVATE_TRANSCRIPT_NEVER_FORWARD' }],
  ])
  const ms = await mirrorFixture(), mirror = new MirrorDO({ storage: ms.storage }, {})
  const mirrorCalls = [], requests = []
  const env = { WAKE_EXECUTOR_ENABLED: '1', DEEPSEEK_API_KEY: 'synthetic-provider-credential', ANTHROPIC_API_KEY: 'synthetic-unused-credential',
    PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '20', PROVIDER_BUDGET_TOKENS: '1000000', PROVIDER_MAX_OUTPUT_TOKENS: '400',
    MIRROR: { idFromName: name => name, get: () => ({ fetch: request => { mirrorCalls.push(new URL(request.url).pathname); return mirror.fetch(request) } }) }, ...override }
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => [] }, env)
  head.broadcast = async () => {}
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com/chat/completions' : 'https://api.openai.com/v1/chat/completions')
    const body = JSON.parse(init.body), index = requests.length
    const logs = [...hs.snapshot().entries()].filter(([key]) => key.startsWith('head:transcript:row:')).map(([, row]) => row.content)
    assert.ok(logs.some(text => { try { return JSON.stringify(JSON.parse(text).request) === init.body } catch { return false } }), 'Exact request must already be durable')
    assert.equal(init.body.includes('PRIVATE_TRANSCRIPT_NEVER_FORWARD'), false)
    assert.equal(init.body.includes('synthetic-provider-credential'), false)
    requests.push(body)
    const answer = answers[index]
    assert.notEqual(answer, undefined, 'Unexpected provider round')
    return typeof answer === 'function' ? answer({ hs, ms, init, body }) : Response.json({ choices: [{ message: answer }] })
  })
  return { head, hs, ms, env, requests, mirrorCalls, run: options => head.executeCloudWakeStep({ now: 1000000, ...options }) }
}

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const answerCalls = (...tool_calls) => ({ content: null, tool_calls })

test('cloud wake runs bounded tool protocol with exact transcripts and per-round budget', async t => {
  const f = await wakeFixture(t, [answerCalls(call('read', 'readMirrorText', { path: CLOUD_WAKE_PATHS[0] }), call('inspect', 'inspectHeadWish')),
    answerCalls(call('checkpoint', 'appendWakeCheckpoint')), { content: 'WISH_COMPLETED: observed epoch 2 and recorded checkpoint.' }])
  assert.deepEqual(await f.run(), { status: 'success', toolCalls: 3, evidenceCount: 2 })
  assert.equal(f.requests.length, 3)
  assert.equal(f.requests[2].tool_choice, 'none')
  assert.deepEqual(f.mirrorCalls, ['/_mirror/wake-read', '/_mirror/wake-checkpoint'])
  assert.equal((await f.hs.storage.get('provider-budget:v1:deepseek')).requests, 3)
  assert.equal(await f.hs.storage.get('provider-budget:v1:anthropic'), undefined)
  assert.equal((await f.hs.storage.get('head:wish:active')).status, 'running')
  assert.equal((await f.hs.storage.get('head:wish:active')).lastEvidenceStatus, 'completion_proposed')
  assert.equal((await f.ms.storage.get(FENCE)).revision, 2)
  assert.ok(f.requests[2].messages.some(message => message.role === 'tool' && JSON.parse(message.content).path === CLOUD_WAKE_CHECKPOINT_PATH))
})

test('completion without tools cannot complete wishes; no-browser claims do not block', async t => {
  const f = await wakeFixture(t, [{ content: 'WISH_COMPLETED' }, { content: 'I cannot use a browser. WISH_BLOCKED' }])
  assert.equal((await f.run()).status, 'success')
  assert.equal((await f.hs.storage.get('head:wish:active')).status, 'running')
  assert.equal((await f.hs.storage.get('head:wish:active')).lastEvidenceStatus, 'no_tool_evidence')
  assert.equal((await f.run()).status, 'success')
  assert.equal((await f.hs.storage.get('head:wish:active')).status, 'running')
})

test('metadata inspection plus model completion marker never verifies arbitrary acceptance', async t => {
  const f = await wakeFixture(t, [answerCalls(call('inspect', 'inspectHeadWish')), { content: 'WISH_COMPLETED' }])
  assert.equal((await f.run()).status, 'success')
  const wish = await f.hs.storage.get('head:wish:active')
  assert.equal(wish.status, 'running')
  assert.equal(wish.lastEvidenceStatus, 'completion_proposed')
})

test('unknown tools, arbitrary paths, extra arguments and malformed JSON never reach Mirror', async t => {
  const invalid = call('malformed', 'inspectHeadWish'); invalid.function.arguments = '{'
  const f = await wakeFixture(t, [answerCalls(call('shell', 'exec', { command: 'never execute' }), call('private', 'readMirrorText', { path: '/dsh/home/auma/sessions/private' }),
    call('extra', 'appendWakeCheckpoint', { text: 'arbitrary text' }), invalid), { content: 'No supported evidence collected.' }])
  assert.equal((await f.run()).status, 'success')
  assert.deepEqual(f.mirrorCalls, [])
  const tools = f.requests[1].messages.filter(message => message.role === 'tool')
  assert.equal(tools.length, 4)
  assert.ok(tools.every(message => JSON.parse(message.content).ok === false))
})

test('missing budget fails closed without provider dispatch or wish progress', async t => {
  const f = await wakeFixture(t, [], { PROVIDER_BUDGET_REQUESTS: undefined })
  assert.equal((await f.run()).status, 'failed')
  assert.equal(f.requests.length, 0)
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
})

test('budget exhaustion on next round retains first reservation without dispatch', async t => {
  const f = await wakeFixture(t, [answerCalls(call('inspect', 'inspectHeadWish'))], { PROVIDER_BUDGET_REQUESTS: '1' })
  assert.equal((await f.run()).status, 'failed')
  assert.equal(f.requests.length, 1)
  assert.equal((await f.hs.storage.get('provider-budget:v1:deepseek')).requests, 1)
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
})

test('aborted noncooperative provider cannot progress wish or dispatch tools later', async t => {
  const controller = new AbortController()
  let finish, cancelled = false
  const f = await wakeFixture(t, [() => { controller.abort(); return new Promise(resolve => { finish = resolve }) }])
  assert.equal((await f.run({ signal: controller.signal })).reason, 'cloud_wake_cancelled')
  finish(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
  assert.deepEqual(f.mirrorCalls, [])
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
})

test('deadline stops a noncooperative provider without waiting for its response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await wakeFixture(t, [() => {
    t.mock.timers.tick(CLOUD_WAKE_LIMITS.deadlineMs)
    return new Promise(() => {})
  }])
  assert.equal((await f.run()).reason, 'cloud_wake_cancelled')
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
  assert.deepEqual(f.mirrorCalls, [])
})

test('changed bootstrap seed and HEAD identity fence off returned tool calls', async t => {
  const f = await wakeFixture(t, [async ({ hs }) => {
    await hs.storage.put('bootstrap:v1', { phase: 'complete', seedId: ID })
    return Response.json({ choices: [{ message: answerCalls(call('seed-stale', 'inspectHeadWish')) }] })
  }, async ({ hs }) => {
    await hs.storage.put('head:current', { ballId: ID, epoch: 3 })
    return Response.json({ choices: [{ message: answerCalls(call('head-stale', 'inspectHeadWish')) }] })
  }])
  assert.equal((await f.run()).status, 'failed')
  await f.hs.storage.put('bootstrap:v1', { phase: 'complete', seedId: SEED })
  assert.equal((await f.run()).status, 'failed')
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.mirrorCalls, [])
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
})

test('OpenAI fallback uses the same protocol while Anthropic-only configuration dispatches nothing', async t => {
  const f = await wakeFixture(t, [{ content: 'Continuity reviewed without claiming acceptance.' }], { DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: 'synthetic-openai-credential' })
  assert.equal((await f.run()).status, 'success')
  assert.equal((await f.hs.storage.get('provider-budget:v1:openai')).requests, 1)
  delete f.env.OPENAI_API_KEY
  assert.equal((await f.run()).reason, 'provider_unavailable')
  assert.equal(f.requests.length, 1)
  assert.equal(await f.hs.storage.get('provider-budget:v1:anthropic'), undefined)
})

test('stopped wish fences off returned tools and completion', async t => {
  const f = await wakeFixture(t, [async ({ hs }) => {
    const wish = await hs.storage.get('head:wish:active')
    await hs.storage.put('head:wish:active', { ...wish, status: 'stopped' })
    return Response.json({ choices: [{ message: answerCalls(call('late', 'inspectHeadWish')) }] })
  }])
  assert.equal((await f.run()).status, 'failed')
  assert.deepEqual(f.mirrorCalls, [])
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
})

test('provider call cap and response byte ceiling fail before tool execution', async t => {
  const f = await wakeFixture(t, [answerCalls(...Array.from({ length: 7 }, (_, index) => call('call' + index, 'inspectHeadWish'))),
    () => new Response('x'.repeat(CLOUD_WAKE_LIMITS.responseBytes + 1))])
  assert.equal((await f.run()).status, 'failed')
  assert.equal((await f.run()).status, 'failed')
  assert.deepEqual(f.mirrorCalls, [])
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
})


test('wake continuity reads enforce finite paths before touching storage', async () => {
  const f = await mirrorFixture()
  f.reads.length = 0
  for (const path of ['/dsh/home/auma/sessions/private.jsonl', '/dsh/home/auma/.credentials.yaml', '/dsh/workspace/private', CLOUD_WAKE_PATHS[0] + '/..', CLOUD_WAKE_CHECKPOINT_PATH]) {
    await assert.rejects(readMirrorWakeText(f.storage, { path, seedId: SEED }), /MIRROR_WAKE_PATH_REFUSED/)
  }
  assert.deepEqual(f.reads, [])
  assert.deepEqual(await readMirrorWakeText(f.storage, { path: CLOUD_WAKE_PATHS[0], seedId: SEED }), { ok: true, path: CLOUD_WAKE_PATHS[0], text: 'Continuity epoch 2', revision: 1 })
})

test('wake reads refuse wrong bootstrap, oversized files, malformed chunks and credential text', async () => {
  for (const text of ['password=synthetic-secret', 'Bearer synthetic-access', '-----BEGIN PRIVATE KEY-----', 'x'.repeat(CLOUD_WAKE_LIMITS.textBytes + 1)]) {
    const f = await mirrorFixture(text)
    await assert.rejects(readMirrorWakeText(f.storage, { path: CLOUD_WAKE_PATHS[0], seedId: SEED }))
  }
  const f = await mirrorFixture()
  await assert.rejects(readMirrorWakeText(f.storage, { path: CLOUD_WAKE_PATHS[0], seedId: ID }), /BOOTSTRAP_REQUIRED/)
  const key = await mirrorDigest(CLOUD_WAKE_PATHS[0])
  await f.storage.put(PREFIX + 'chunk:' + key + ':0', 'broken')
  await assert.rejects(readMirrorWakeText(f.storage, { path: CLOUD_WAKE_PATHS[0], seedId: SEED }), /MIRROR_FILE_CHUNK_CORRUPT/)
  assert.equal(cloudWakeTextSafe('synthetic-config-secret', { UNLISTED_SECRET: 'synthetic-config-secret' }), false)
})

test('checkpoint append is bootstrap-gated, bounded, idempotent and advances the global fence', async () => {
  const f = await mirrorFixture(), input = checkpoint()
  const empty = fixtureStorage()
  await assert.rejects(appendMirrorWakeCheckpoint(empty.storage, input, { seedId: SEED }), /BOOTSTRAP_REQUIRED/)
  assert.equal(empty.snapshot().size, 0)
  assert.deepEqual(await appendMirrorWakeCheckpoint(f.storage, input, { seedId: SEED }), { ok: true, id: ID, revision: 2, replayed: false })
  assert.deepEqual(await appendMirrorWakeCheckpoint(f.storage, input, { seedId: SEED }), { ok: true, id: ID, revision: 2, replayed: true })
  await assert.rejects(appendMirrorWakeCheckpoint(f.storage, { ...input, at: 1001 }, { seedId: SEED }), /MIRROR_WAKE_CHECKPOINT_CONFLICT/)
  const before = f.snapshot()
  for (const bad of [{ ...input, path: '/tmp/private' }, { ...input, text: 'arbitrary write' }, { ...input, evidence: [] }, { ...input, evidence: [{ tool: 'shell', digest: ID }] }]) {
    await assert.rejects(appendMirrorWakeCheckpoint(f.storage, bad, { seedId: SEED }), /MIRROR_WAKE_CHECKPOINT_INVALID/)
  }
  assert.deepEqual(f.snapshot(), before)
  const key = await mirrorDigest(CLOUD_WAKE_CHECKPOINT_PATH)
  const contents = atob(await f.storage.get(PREFIX + 'chunk:' + key + ':0'))
  assert.deepEqual(JSON.parse(contents), { schema: 'aukora.cloud-wake-checkpoint.v1', ...input })
})

test('checkpoint cancellation cannot mutate storage; browser deletion cannot erase checkpoint history', async () => {
  const f = await mirrorFixture(), controller = new AbortController()
  controller.abort()
  const before = f.snapshot()
  await assert.rejects(appendMirrorWakeCheckpoint(f.storage, checkpoint(), { seedId: SEED, signal: controller.signal }))
  assert.deepEqual(f.snapshot(), before)
  await appendMirrorWakeCheckpoint(f.storage, checkpoint(), { seedId: SEED })
  const clientId = '22222222-2222-4222-8222-222222222222'
  const batch = { id: clientId + ':1', clientId, seq: 1, cloudBase: { lineageId: LINEAGE, revision: 2 }, entries: [[CLOUD_WAKE_CHECKPOINT_PATH, { kind: 'gone' }]] }
  await assert.rejects(publishMirror(f.storage, { v: 2, batch, digest: await mirrorDigest(batch) }), /MIRROR_HISTORY_APPEND_ONLY/)
})

test('wake internal routes reject missing authorization, seed, query, method and extra fields', async () => {
  const f = await mirrorFixture(), mirror = new MirrorDO({ storage: f.storage }, {})
  const request = (path, input, headers = {}, method = 'POST') => new Request('https://internal.invalid' + path, { method,
    headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED, ...headers }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) })
  for (const req of [request('/_mirror/wake-read', { path: CLOUD_WAKE_PATHS[0] }, { 'x-x6-internal-authorized': '0' }),
    request('/_mirror/wake-read', { path: CLOUD_WAKE_PATHS[0] }, { 'x-x6-bootstrap-seed': '' }),
    request('/_mirror/wake-read?', { path: CLOUD_WAKE_PATHS[0] }), request('/_mirror/wake-read', {}, {}, 'GET'),
    request('/_mirror/wake-read', { path: CLOUD_WAKE_PATHS[0], extra: true })]) assert.ok((await mirror.fetch(req)).status >= 400)
  const response = await mirror.fetch(request('/_mirror/wake-read', { path: CLOUD_WAKE_PATHS[0] }))
  assert.equal((await response.json()).text, 'Continuity epoch 2')
})

test('checkpoint receipts remain usable for the next ordinary browser publish', async () => {
  const f = await mirrorFixture()
  await appendMirrorWakeCheckpoint(f.storage, checkpoint(), { seedId: SEED })
  const clientId = '22222222-2222-4222-8222-222222222222'
  const batch = { id: clientId + ':1', clientId, seq: 1, cloudBase: { lineageId: LINEAGE, revision: 2 },
    entries: [['/dsh/home/auma/ordinary.txt', { kind: 'file', mode: 0o600, mtimeMs: 1, b64: btoa('fixture') }]] }
  assert.equal((await publishMirror(f.storage, { v: 2, batch, digest: await mirrorDigest(batch) })).revision, 3)
  assert.equal((await appendMirrorWakeCheckpoint(f.storage, { ...checkpoint(), id: 'e'.repeat(64) }, { seedId: SEED })).revision, 4)
})

test('checkpoint storage ceiling refuses new writes without evicting existing history', async () => {
  const f = await mirrorFixture()
  const path = CLOUD_WAKE_CHECKPOINT_PATH, key = await mirrorDigest(path)
  const rows = Array.from({ length: 128 }, (_, index) => ({ schema: 'aukora.cloud-wake-checkpoint.v1', ...checkpoint(), id: index.toString(16).padStart(64, '0') }))
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  await f.storage.put(PREFIX + 'entry:' + key, { path, kind: 'file', mode: 0o600, mtimeMs: 1, bytes: text.length, chunks: 1 })
  await f.storage.put(PREFIX + 'chunk:' + key + ':0', btoa(text))
  const before = f.snapshot()
  await assert.rejects(appendMirrorWakeCheckpoint(f.storage, checkpoint(), { seedId: SEED }), /MIRROR_WAKE_CHECKPOINT_FULL/)
  assert.deepEqual(f.snapshot(), before)
})


test('stored wake counts and transcript sequence are strict finite integers before provider dispatch', async t => {
  for (const [key, values] of [
    ['head:wake:daily:1970-01-01', [null, '0', false, -1, NaN, 48]],
    ['head:transcript:seq', [null, '0', false, -1, NaN, Number.MAX_SAFE_INTEGER]],
  ]) {
    for (const value of values) {
      const f = await wakeFixture(t, [])
      await f.hs.storage.put(key, value)
      assert.notEqual((await f.run()).status, 'success')
      assert.equal(f.requests.length, 0)
      assert.deepEqual(await f.hs.storage.get(key), value)
      assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
    }
  }
})

test('malformed wish step counts fail closed without model or tool dispatch', async t => {
  for (const patch of [{ stepsCompleted: null }, { stepsCompleted: '0' }, { stepsCompleted: -1 }, { maxSteps: null }, { maxSteps: '3' }, { maxSteps: 25 }]) {
    const f = await wakeFixture(t, [])
    await f.hs.storage.put('head:wish:active', { ...await f.hs.storage.get('head:wish:active'), ...patch })
    assert.equal((await f.run()).status, 'failed')
    assert.equal(f.requests.length, 0); assert.deepEqual(f.mirrorCalls, [])
  }
})

test('A VALID JSON answer over the wake\'s own 32 KiB ceiling fails, through the model door too', async t => {
  // A small, acceptable message, padded outside the message (the door ignores unknown fields): only the byte ceiling
  // can refuse it. The same answer under the ceiling succeeds.
  const answer = padding => ({ choices: [{ message: { content: 'Observed.' } }], padding: 'p'.repeat(padding) })
  const over = answer(40_000), under = answer(1_000)
  assert.ok(Buffer.byteLength(JSON.stringify(over)) > CLOUD_WAKE_LIMITS.responseBytes)
  assert.ok(Buffer.byteLength(JSON.stringify(over)) < 64 * 1024)
  const control = await wakeFixture(t, [() => Response.json(under)])
  assert.equal((await control.run()).status, 'success')
  const f = await wakeFixture(t, [() => Response.json(over)])
  const result = await f.run()
  assert.equal(result.status, 'failed')
  assert.equal((await f.hs.storage.get('head:wish:active')).stepsCompleted, 0)
})

test('Wake evidence comes from the one shared list MIRROR also accepts', async () => {
  const { isCloudWakeEvidenceTool, cloudWakeToolNames } = await import('../head-do.mjs')
  const { CLOUD_WAKE_EVIDENCE_TOOLS } = await import('../wake-evidence.mjs')
  const names = cloudWakeToolNames()
  // Every evidence name is a real wake tool, and the checkpoint tool itself is never evidence.
  for (const name of CLOUD_WAKE_EVIDENCE_TOOLS) assert.ok(names.includes(name), name)
  assert.equal(isCloudWakeEvidenceTool('appendWakeCheckpoint'), false)
  // HEAD decides by the list, not by "anything but appendWakeCheckpoint": an unlisted name is not evidence.
  for (const name of names) assert.equal(isCloudWakeEvidenceTool(name), CLOUD_WAKE_EVIDENCE_TOOLS.includes(name), name)
  assert.equal(isCloudWakeEvidenceTool('futureUnlistedTool'), false)
})
