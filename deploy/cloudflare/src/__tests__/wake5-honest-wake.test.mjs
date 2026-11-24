/** Her first live no-tab wish. (A) a wake checkpoint written while no tab was
 * connected moved the cloud's version past her closed tab's base; (B) a step with no evidence still counted as a clean
 * step; (C) Stop did not show that the alarm was gone; (D) `recentCommits` was refused broker_upstream_failed with no fact
 * about which hop said no. Real HEAD and real MIRROR on in-memory storage, a fake DeepSeek in the live shape and a fake
 * GitHub. Synthetic values only: no live provider, no user data. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, CLOUD_WAKE_PATHS } from '../head-do.mjs'
import { MirrorDO, mirrorDigest, publishMirror } from '../mirror-do.mjs'
import { executeCloudBrowserBody } from '../cloud-body.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64), OTHER = 'c'.repeat(64)
const LINEAGE = '11111111-1111-4111-8111-111111111111'
const PREFIX = 'mirror:v2:', FENCE = PREFIX + 'global-fence'
const GH = 'ghp_FIXTUREnotarealvalue0123456789abcd'
const REPO = 'https://api.github.com/repos/your_org_x/your-node'
const NOTES = Buffer.from('# Her notes\n- one line\n')

const dsCall = (index, id, name, args = {}) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const deepseekTools = (...calls) => Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'deepseek-chat',
  choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: calls }, logprobs: null, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
const deepseekSay = content => Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'deepseek-chat',
  choices: [{ index: 0, message: { role: 'assistant', content }, logprobs: null, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })
const lookThenCheckpoint = () => deepseekTools(dsCall(0, 'call_00_look', 'inspectHeadWish'), dsCall(1, 'call_01_cp', 'appendWakeCheckpoint'))

function memoryStorage(initial = []) {
  let rows = new Map(initial), alarm = null, tail = Promise.resolve()
  const writes = []
  const view = (data, timer) => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { writes.push(key); data.set(key, structuredClone(value)) },
    delete: async key => { data.delete(key) },
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => timer.value, setAlarm: async value => { timer.value = value }, deleteAlarm: async () => { timer.value = null },
  })
  const storage = {
    get: key => view(rows, { value: alarm }).get(key),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
    delete: async key => { rows.delete(key) },
    list: options => view(rows, { value: alarm }).list(options),
    getAlarm: async () => alarm,
    transaction(operation) {
      const result = tail.then(async () => {
        const data = structuredClone(rows), timer = { value: alarm }
        const value = await operation(view(data, timer))
        rows = data; alarm = timer.value
        return value
      })
      tail = result.catch(() => {})
      return result
    },
  }
  return { storage, rows: () => rows, alarm: () => alarm, writes }
}

async function mirrorStorage() {
  const ms = memoryStorage([['mirror:bootstrap:v1', { phase: 'ready', seedId: SEED, lineageId: LINEAGE, revision: 1,
    ballId: BALL, epoch: 2, batchDigests: [OTHER], nextBatch: 1, entryCount: 1, expectedEntries: 1 }], [FENCE, { lineageId: LINEAGE, revision: 1 }]])
  const path = CLOUD_WAKE_PATHS[0], key = await mirrorDigest(path), b64 = NOTES.toString('base64')
  await ms.storage.put(PREFIX + 'entry:' + key, { path, kind: 'file', mode: 0o600, mtimeMs: 1, bytes: NOTES.length, chunks: 1 })
  await ms.storage.put(PREFIX + 'chunk:' + key + ':0', b64)
  return ms
}

/** @param {{ answers?: Response[], wish?: object|null, github?: (url: string) => Response | Promise<Response> }} options */
async function fixture(t, { answers = [], wish = {}, github } = {}) {
  const now = 1000000
  const hs = memoryStorage([['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: BALL, epoch: 2, entries: {} }],
    ...(wish === null ? [] : [['head:wish:active', { wish_id: 'w1', intent: 'Read my notes, then my recent commits', acceptance: 'Two read steps recorded',
      status: 'running', stepsCompleted: 0, maxSteps: 6, ...wish }]])])
  const mirrorStore = await mirrorStorage()
  const mirror = new MirrorDO({ storage: mirrorStore.storage }, {})
  const mirrorCalls = []
  const env = { DEEPSEEK_API_KEY: 'synthetic-provider-value-wake5', CLOUD_WAKE_PROVIDER: 'deepseek', GITHUB_TOKEN: GH, PROVIDER_BUDGET_WINDOW_MS: '60000',
    PROVIDER_BUDGET_REQUESTS: '100', PROVIDER_BUDGET_TOKENS: '10000000', PROVIDER_MAX_OUTPUT_TOKENS: '400', WAKE_EXECUTOR_ENABLED: '1',
    MIRROR: { idFromName: name => name, get: () => ({ fetch: request => { mirrorCalls.push(new URL(request.url).pathname); return mirror.fetch(request) } }) } }
  let clock = now
  t.mock.method(Date, 'now', () => clock)
  const requests = [], githubRequests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://api.github.com/')) {
      githubRequests.push(String(url))
      if (!github) throw new Error('unexpected GitHub request ' + url)
      return github(String(url), init)
    }
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
    requests.push(JSON.parse(init.body))
    const answer = answers.shift()
    assert.notEqual(answer, undefined, 'Unexpected provider round')
    return answer
  })
  const head = new X61HeadDurableObject({ storage: hs.storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore.dispose())
  head.broadcast = async () => {}
  const post = async (body, path = '/_head/transcript') => {
    const response = await head.fetch(new Request('https://wake.example.invalid' + path, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
    assert.equal(response.status, 200)
    return response.json()
  }
  const toolAnswers = () => Object.fromEntries(requests.flatMap(body => body.messages.filter(message => message.role === 'tool'))
    .map(message => [message.tool_call_id, JSON.parse(message.content)]))
  return { head, hs, mirrorStore, requests, githubRequests, mirrorCalls, post, toolAnswers, now: () => clock,
    wish: () => hs.storage.get('head:wish:active'), day: () => hs.storage.get('head:wake:daily:1970-01-01'),
    step: (options = {}) => head.executeCloudWakeStep({ now: clock, ...options }), advance: ms => { clock += ms } }
}

/** One ordinary save from her tab, on the cloud version it last saw (the tab's cloudBase). */
async function tabSave(storage, revision, seq = 1) {
  const clientId = '22222222-2222-4222-8222-222222222222'
  const batch = { id: clientId + ':' + seq, clientId, seq, cloudBase: { lineageId: LINEAGE, revision },
    entries: [['/dsh/home/auma/ordinary.txt', { kind: 'file', mode: 0o600, mtimeMs: 1, b64: btoa('saved ' + seq) }]] }
  return publishMirror(storage, { v: 2, batch, digest: await mirrorDigest(batch) })
}

// ---- A. A wake checkpoint never strands a tab ----

test('A: with no tab connected, two wake checkpoints leave the whole mirror byte-identical, and a tab at base 1 saves in step after them', async t => {
  const f = await fixture(t, { answers: [lookThenCheckpoint(), deepseekSay('Looked; no checkpoint.'), lookThenCheckpoint(), deepseekSay('Looked again.')] })
  const before = structuredClone(f.mirrorStore.rows())
  for (const step of [1, 2]) {
    const out = await f.step()
    assert.equal(out.status, 'success', JSON.stringify(out))
    assert.deepEqual(out.toolRefusals, [{ tool: 'appendWakeCheckpoint', code: 'cloud_wake_checkpoint_unavailable', mirrorCode: 'mirror_wake_checkpoint_paused' }], `step ${step}`)
    assert.deepEqual(f.toolAnswers().call_01_cp, { ok: false, code: 'CLOUD_WAKE_CHECKPOINT_UNAVAILABLE', mirrorCode: 'MIRROR_WAKE_CHECKPOINT_PAUSED' })
    assert.equal((await f.wish()).stepsCompleted, step, 'the step still counts and goes on')
  }
  assert.deepEqual(f.mirrorCalls, [], 'no checkpoint request reaches the mirror')
  // The fence, every receipt, every client head and every entry of the versioned home: byte-identical.
  assert.deepEqual(f.mirrorStore.rows(), before)
  assert.deepEqual(await f.mirrorStore.storage.get(FENCE), { lineageId: LINEAGE, revision: 1 })
  // Her tab last saw cloud version 1: its next save is applied by the real mirror (not refused as out of step).
  const saved = await tabSave(f.mirrorStore.storage, 1)
  assert.equal(saved.ok, true)
  assert.equal(saved.revision, 2)
})

// ---- B. A step that produced no evidence is never counted as a clean step ----

test('B: a 2-step wish whose step 2 yields no evidence ends stepsCompleted 2, stepsWithEvidence 1, endedWith steps_without_evidence, day count 2', async t => {
  const f = await fixture(t, { wish: { maxSteps: 2 }, github: () => new Response('{"message":"Bad credentials"}', { status: 401, headers: { 'content-type': 'application/json' } }),
    answers: [deepseekTools(dsCall(0, 'call_00_look', 'inspectHeadWish')), deepseekSay('Observed epoch 2.'),
      deepseekTools(dsCall(0, 'call_01_log', 'recentCommits')), deepseekTools(dsCall(0, 'call_02_log', 'recentCommits')), deepseekSay('Could not read my commits.')] })
  assert.equal((await f.step()).status, 'success')
  const first = await f.wish()
  assert.deepEqual([first.stepsCompleted, first.stepsWithEvidence, first.status], [1, 1, 'running'])
  // Step 2 through her own route (x6_wish step): its answer carries the wish with both numbers.
  const stepped = await f.post({ action: 'wish_step' })
  assert.equal(stepped.ok, true, JSON.stringify(stepped))
  assert.deepEqual(stepped.toolRefusals.map(row => [row.tool, row.code]), [['recentCommits', 'broker_upstream_failed'], ['recentCommits', 'broker_upstream_failed']])
  const wish = await f.wish()
  assert.deepEqual(stepped.wish, { ...wish, evidenceCountKnown: true })
  assert.deepEqual([wish.stepsCompleted, wish.stepsWithEvidence, wish.status, wish.endedWith], [2, 1, 'exhausted', 'steps_without_evidence'])
  assert.deepEqual(wish.steps.map(row => [row.step, row.outcome]), [[1, 'step_recorded'], [2, 'no_tool_evidence']], 'no step is hidden, retried or refunded')
  assert.equal(await f.day(), 2, 'every step that ran is counted against the day')
  const status = await f.post({ action: 'wish_status' })
  assert.deepEqual([status.wish.stepsCompleted, status.wish.stepsWithEvidence, status.wish.endedWith, status.dailyStepsUsed], [2, 1, 'steps_without_evidence', 2])
  const probe = await f.post({ action: 'wish_probe' })
  assert.deepEqual([probe.probe.wish.stepsCompleted, probe.probe.wish.stepsWithEvidence, probe.probe.wish.status, probe.probe.wish.endedWith], [2, 1, 'exhausted', 'steps_without_evidence'])
})

test('B: a wish whose every step had evidence ends exhausted with no steps_without_evidence; a wish from before the field counts its rows', async t => {
  const f = await fixture(t, { wish: { maxSteps: 2 }, answers: [deepseekTools(dsCall(0, 'a', 'inspectHeadWish')), deepseekSay('One.'),
    deepseekTools(dsCall(0, 'b', 'inspectHeadWish')), deepseekSay('Two.')] })
  await f.step(); await f.step()
  const wish = await f.wish()
  assert.deepEqual([wish.stepsCompleted, wish.stepsWithEvidence, wish.status, wish.endedWith], [2, 2, 'exhausted', undefined])
  // A wish stored before stepsWithEvidence existed: its step rows are counted (only step_recorded and completion_proposed).
  const legacy = await fixture(t, { wish: { maxSteps: 3, stepsCompleted: 2, steps: [{ step: 1, at: 1, outcome: 'no_tool_evidence', toolCalls: 0 },
    { step: 2, at: 2, outcome: 'completion_proposed', toolCalls: 1 }, { step: 3, at: 3, outcome: 'failed', reason: 'internal' }] },
  answers: [deepseekSay('Nothing read.')] })
  await legacy.step()
  const after = await legacy.wish()
  assert.deepEqual([after.stepsCompleted, after.stepsWithEvidence, after.status, after.endedWith], [3, 1, 'exhausted', 'steps_without_evidence'])
})

// ---- C. Stop is provably final ----

test('C: Stop answers the wish, the wake switch and the alarm as read back after it; a late alarm then runs nothing and re-arms nothing', async t => {
  const f = await fixture(t, { wish: null })
  const created = await f.post({ action: 'wish_create', intent: 'Read my notes', maxSteps: 2, everySeconds: 60 })
  assert.equal(created.ok, true)
  assert.notEqual(f.hs.alarm(), null, 'creating the wish armed the alarm')
  const stopped = await f.post({ action: 'wish_stop' })
  assert.deepEqual([stopped.ok, stopped.wish.status, stopped.wish.wakeReleased, stopped.wake.enabled], [true, 'stopped', true, false])
  assert.deepEqual(stopped.alarm, { scheduledAt: await f.hs.storage.getAlarm() }, 'the answer\'s alarm is exactly what getAlarm returns')
  assert.equal(stopped.alarm.scheduledAt, null)
  // The platform delivers an alarm that was already on its way.
  f.advance(60000)
  const writesBefore = f.hs.writes.length
  const late = await f.head.alarm()
  assert.equal(late.skipped, 'disabled')
  assert.equal(f.requests.length, 0, 'no provider call')
  assert.equal(await f.day(), undefined, 'no count')
  const wish = await f.wish()
  assert.deepEqual([wish.status, wish.stepsCompleted, wish.steps, wish.stepFailures], ['stopped', 0, [], undefined], 'no step row')
  assert.equal(f.hs.alarm(), null, 'nothing re-armed')
  assert.equal(f.hs.writes.slice(writesBefore).includes('head:wake:step-claim'), false)
  assert.equal((await f.head.wakeStore.status()).wakeCount, 0, 'no wake receipt')
})

test('C: when Stop cannot switch the wake off, its answer says so (alarm still set), and the next alarm switches it off with no step', async t => {
  const f = await fixture(t, { wish: null })
  await f.post({ action: 'wish_create', intent: 'Read my notes', maxSteps: 2, everySeconds: 60 })
  t.mock.method(f.head.wakeStore, 'configure', async () => { throw Object.assign(new Error('WAKE_STATE_INVALID'), { code: 'WAKE_STATE_INVALID' }) }, { times: 1 })
  const stopped = await f.post({ action: 'wish_stop' })
  assert.equal(stopped.wish.status, 'stopped')
  assert.notEqual(stopped.wish.wakeReleased, true, 'not released while its wake is still on')
  assert.equal(stopped.wake.enabled, true)
  assert.deepEqual(stopped.alarm, { scheduledAt: await f.hs.storage.getAlarm() })
  assert.notEqual(stopped.alarm.scheduledAt, null)
  f.advance(60000)
  const writesBefore = f.hs.writes.length
  const late = await f.head.alarm()
  assert.equal(late.skipped, 'wish_ended')
  assert.equal(f.requests.length, 0, 'no provider call')
  assert.equal(await f.day(), undefined, 'no count')
  const wish = await f.wish()
  assert.deepEqual([wish.status, wish.wakeReleased, wish.steps, wish.stepFailures], ['stopped', true, [], undefined])
  assert.equal(f.hs.alarm(), null, 'nothing re-armed')
  assert.equal((await f.head.wakeStore.status()).enabled, false)
  assert.equal(f.hs.writes.slice(writesBefore).includes('head:wake:step-claim'), false)
})

test('C: the alarm\'s one other user, the owner\'s own wake timer switched on after Stop, keeps its alarm; its ticks run no step for the stopped wish', async t => {
  const f = await fixture(t, { wish: null })
  await f.post({ action: 'wish_create', intent: 'Read my notes', maxSteps: 2, everySeconds: 60 })
  await f.post({ action: 'wish_stop' })
  await f.post({ action: 'configure', enabled: true, intervalMs: 60000 }, '/_host/wake')
  const writesBefore = f.hs.writes.length
  for (const _tick of [1, 2]) { f.advance(60000); await f.head.alarm() }
  assert.notEqual(f.hs.alarm(), null, 'his timer keeps its alarm')
  assert.equal((await f.head.wakeStore.status()).enabled, true)
  assert.equal(f.requests.length, 0)
  assert.equal(await f.day(), undefined)
  assert.deepEqual((await f.wish()).steps, [])
  assert.equal(f.hs.writes.slice(writesBefore).includes('head:wake:step-claim'), false, 'a tick for a stopped wish never even claims a step')
  // A step through the alarm's own path for an absent wish: refused the same way, before any claim, count or call.
  const empty = await fixture(t, { wish: null })
  assert.deepEqual(await empty.step({ via: 'alarm' }), { status: 'success' })
  assert.equal(empty.hs.writes.includes('head:wake:step-claim'), false)
  assert.equal(await empty.day(), undefined)
})

// ---- D. Why recentCommits answered broker_upstream_failed: the cause is not in the source; the next live run names it ----

for (const [label, github, facts] of [
  ['GitHub answers 401', () => new Response('{"message":"Bad credentials"}', { status: 401, headers: { 'content-type': 'application/json' } }), { hop: 'github', statusClass: '4xx', httpStatus: 401 }],
  ['GitHub answers 502', () => new Response('upstream', { status: 502 }), { hop: 'github', statusClass: '5xx' }],
  ['the request to GitHub never gets an answer', () => { throw new TypeError('network connection lost') }, { hop: 'github', statusClass: 'no_answer' }],
]) {
  test(`D: ${label}: recentCommits is still refused broker_upstream_failed, and its refusal row now names the hop and the answer's class`, async t => {
    const f = await fixture(t, { github, answers: [deepseekTools(dsCall(0, 'call_00_note', 'readMirrorText', { path: CLOUD_WAKE_PATHS[0] }), dsCall(1, 'call_01_log', 'recentCommits')),
      deepseekSay('Read my notes; my commits did not come.')] })
    const out = await f.step()
    assert.equal(out.status, 'success', JSON.stringify(out))
    assert.equal(f.toolAnswers().call_00_note.ok, true, 'readMirrorText succeeds: it never leaves for GitHub')
    // The model's own answer is unchanged: the closed code only.
    assert.deepEqual(f.toolAnswers().call_01_log, { ok: false, code: 'BROKER_UPSTREAM_FAILED' })
    assert.deepEqual(f.githubRequests, [`${REPO}/commits?sha=main&per_page=10`], 'one request, the exact shape the broker sends')
    const row = { tool: 'recentCommits', code: 'broker_upstream_failed', ...facts }
    assert.deepEqual(out.toolRefusals, [row])
    const wish = await f.wish()
    assert.deepEqual(wish.steps.at(-1).toolRefusals, [row], 'the step row keeps them')
    assert.equal(wish.steps.at(-1).outcome, 'step_recorded')
  })
}

test('D: a refused read whose GitHub request was answered 2xx, or that made none, carries no upstream facts', async t => {
  const f = await fixture(t, { github: () => Response.json([]), answers: [deepseekTools(dsCall(0, 'a', 'recentCommits'), dsCall(1, 'b', 'readRepoFile', { path: '../etc' })),
    deepseekSay('Nothing.')] })
  const out = await f.step()
  assert.deepEqual(out.toolRefusals, [{ tool: 'recentCommits', code: 'broker_response_invalid' }, { tool: 'readRepoFile', code: 'repo_path_refused' }])
})

// ---- Review round 1 ----

/** Every answer that carries a wish: wish_status, read, the probe, and cloud-body's status (which reads HEAD's read). */
async function evidenceAnswers(f) {
  const pick = wish => ({ stepsCompleted: wish.stepsCompleted, stepsWithEvidence: wish.stepsWithEvidence, evidenceCountKnown: wish.evidenceCountKnown })
  const head = { idFromName: name => name, get: () => ({ fetch: request => new URL(request.url).pathname === '/_head/promotion-status'
    ? Response.json({ ok: true, peers: [], ballId: BALL, epoch: 2 }) : f.head.fetch(request) }) }
  const body = await executeCloudBrowserBody({ env: { HEAD: head }, seedId: SEED, input: { action: 'status' } })
  return { status: pick((await f.post({ action: 'wish_status' })).wish), read: pick((await f.post({ action: 'read' })).wish),
    probe: pick((await f.post({ action: 'wish_probe' })).probe.wish), body: pick(body.activeWish) }
}

test('S1 (review probe P2): an old wish whose log dropped rows gets NO guessed count: 24 steps with evidence end unknown, with no steps_without_evidence verdict', async t => {
  const kept = []
  for (let s = 5; s <= 23; s++) kept.push({ step: s, at: s, outcome: 'step_recorded', toolCalls: 1 })
  while (kept.length < 48) kept.unshift({ step: 4, at: 4, outcome: 'failed', reason: 'internal' })
  const f = await fixture(t, { wish: { maxSteps: 24, stepsCompleted: 23, steps: kept, stepsDropped: 20 },
    answers: [deepseekTools(dsCall(0, 'a', 'inspectHeadWish')), deepseekSay('Step 24.')] })
  const before = await evidenceAnswers(f)
  for (const view of Object.values(before)) assert.deepEqual(view, { stepsCompleted: 23, stepsWithEvidence: null, evidenceCountKnown: false })
  assert.equal((await f.step()).status, 'success')
  const wish = await f.wish()
  assert.deepEqual([wish.stepsCompleted, wish.stepsWithEvidence, wish.status, wish.endedWith], [24, null, 'exhausted', undefined])
  assert.equal(await f.day(), 1)
  const after = await evidenceAnswers(f)
  for (const view of Object.values(after)) assert.deepEqual(view, { stepsCompleted: 24, stepsWithEvidence: null, evidenceCountKnown: false })
})

test('S1: an old wish whose earlier step is missing from its log (no row for it) stays unknown; a stored null stays null', async t => {
  const f = await fixture(t, { wish: { maxSteps: 4, stepsCompleted: 2, steps: [{ step: 2, at: 2, outcome: 'step_recorded', toolCalls: 1 }] },
    answers: [deepseekTools(dsCall(0, 'a', 'inspectHeadWish')), deepseekSay('Three.'), deepseekTools(dsCall(0, 'b', 'inspectHeadWish')), deepseekSay('Four.')] })
  await f.step()
  assert.equal((await f.wish()).stepsWithEvidence, null)
  await f.step()
  const wish = await f.wish()
  assert.deepEqual([wish.stepsCompleted, wish.stepsWithEvidence, wish.status, wish.endedWith], [4, null, 'exhausted', undefined])
})

test('S3: an old wish with a complete log, and a wish made on this build, show the same evidence numbers in every answer', async t => {
  const old = await fixture(t, { wish: { stepsCompleted: 2, steps: [{ step: 1, at: 1, outcome: 'no_tool_evidence', toolCalls: 0 },
    { step: 2, at: 2, outcome: 'step_recorded', toolCalls: 1 }, { step: 3, at: 3, outcome: 'failed', reason: 'internal' }] } })
  for (const view of Object.values(await evidenceAnswers(old))) assert.deepEqual(view, { stepsCompleted: 2, stepsWithEvidence: 1, evidenceCountKnown: true })
  const fresh = await fixture(t, { wish: null })
  await fresh.post({ action: 'wish_create', intent: 'Read my notes', maxSteps: 2 })
  for (const view of Object.values(await evidenceAnswers(fresh))) assert.deepEqual(view, { stepsCompleted: 0, stepsWithEvidence: 0, evidenceCountKnown: true })
})

test('S2: while checkpoints are paused the checkpoint tool is not offered; a step spends no round on it; a call to it anyway is refused PAUSED', async t => {
  const f = await fixture(t, { answers: [deepseekTools(dsCall(0, 'look', 'inspectHeadWish')), deepseekSay('Observed, no checkpoint offered.')] })
  const out = await f.step()
  assert.equal(out.status, 'success')
  assert.equal(f.requests.length, 2, 'two rounds: one look, one answer')
  for (const body of f.requests) assert.equal(body.tools.some(tool => tool.function.name === 'appendWakeCheckpoint'), false, 'not offered')
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === 'inspectHeadWish'))
  // A model that calls it anyway (it was not offered): the closed PAUSED refusal, the mirror is never called.
  const g = await fixture(t, { answers: [lookThenCheckpoint(), deepseekSay('Looked.')] })
  const called = await g.step()
  assert.equal(called.status, 'success')
  assert.deepEqual(g.toolAnswers().call_01_cp, { ok: false, code: 'CLOUD_WAKE_CHECKPOINT_UNAVAILABLE', mirrorCode: 'MIRROR_WAKE_CHECKPOINT_PAUSED' })
  assert.deepEqual(g.mirrorCalls, [])
})
