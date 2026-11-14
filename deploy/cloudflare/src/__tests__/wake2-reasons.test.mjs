/** A failed or blocked wake step names a closed reason, the wish keeps it, status shows it; the probe spends
 * nothing; the alarm path gets the manual path's time. Synthetic storage, alarm and provider only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject, CLOUD_WAKE_LIMITS, CLOUD_WAKE_ALARM_STEP_MS, CLOUD_WAKE_CAUSES, CLOUD_WAKE_FAILURES_KEPT, CLOUD_WAKE_GITHUB_CALLS_PER_STEP, cloudWakeCause } from '../head-do.mjs'
import { WAKE_PROBE_LIMITS } from '../messages-store.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64), DAY = 'head:wake:daily:1970-01-01', NEXT_DAY = 86400000
const SECRET = 'synthetic-provider-value-7f3a'
const PROVIDER_TEXT = 'PROVIDER-BODY-TEXT-never-forward'
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const tools = (...tool_calls) => ({ content: null, tool_calls })
const say = content => ({ content })
const running = (patch = {}) => ({ wish_id: 'w1', intent: 'Inspect continuity', acceptance: 'Record observations', status: 'running', stepsCompleted: 0, maxSteps: 6, ...patch })

function fixture(t, options = {}) {
  const { wish = running(), answers = [] } = options
  let now = 1000000, alarm = null, tail = Promise.resolve()
  let rows = new Map([['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: BALL, epoch: 2, entries: {} }]])
  if (wish) rows.set('head:wish:active', wish)
  for (const [key, value] of options.rows ?? []) rows.set(key, value)
  const writes = []
  const view = (data, timer) => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { writes.push(key); data.set(key, structuredClone(value)) },
    delete: async key => { writes.push(key); data.delete(key) },
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => timer.value,
    setAlarm: async value => { writes.push('alarm'); timer.value = value },
    deleteAlarm: async () => { writes.push('alarm'); timer.value = null },
  })
  const storage = {
    get: key => view(rows, { value: alarm }).get(key),
    put: async (key, value) => { rows.set(key, structuredClone(value)) },
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
  const env = { DEEPSEEK_API_KEY: SECRET, PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '100',
    PROVIDER_BUDGET_TOKENS: '10000000', PROVIDER_MAX_OUTPUT_TOKENS: '400', WAKE_EXECUTOR_ENABLED: '1', ...(options.env ?? {}) }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  t.mock.method(Date, 'now', () => now)
  const requests = [], githubCalls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    // A fake GitHub for the step's reads, counted apart from the provider's rounds.
    if (options.github && String(url).startsWith('https://api.github.com/')) { githubCalls.push(String(url)); return options.github(String(url), init) }
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    const answer = answers.shift()
    assert.notEqual(answer, undefined, 'Unexpected provider round')
    if (typeof answer === 'function') return answer({ rows: () => rows, setRow: (key, value) => rows.set(key, value) })
    if (answer instanceof Response) return answer
    return Response.json({ choices: [{ message: answer }] })
  })
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore.dispose())
  head.broadcast = async () => {}
  const post = async body => {
    const response = await head.fetch(new Request('https://wake.example.invalid/_head/transcript', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': SEED }, body: JSON.stringify(body) }))
    assert.equal(response.status, 200)
    return response.json()
  }
  return { head, storage, env, requests, githubCalls, writes, post, snapshot: () => structuredClone([...rows]), alarmAt: () => alarm, now: () => now,
    wish: () => storage.get('head:wish:active'), day: () => storage.get(DAY), step: () => head.executeCloudWakeStep({ now }) }
}

/** The answer, the wish's failures and `x6_wish status` all carry the reason, and none of them carry provider text or a secret. */
async function assertKept(f, answer, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(answer[key], value, key)
  assert.ok(CLOUD_WAKE_CAUSES.includes(answer.cause), answer.cause)
  const wish = await f.wish()
  const failure = wish.stepFailures.at(-1)
  assert.equal(failure.reason, expected.cause)
  assert.equal(failure.at, f.now())
  assert.equal(failure.step, 1)
  for (const [key, value] of Object.entries(expected)) if (!['cause', 'reason', 'status'].includes(key)) assert.deepEqual(failure[key], value, key)
  const status = await f.post({ action: 'wish_status' })
  assert.deepEqual(status.stepFailures, wish.stepFailures)
  for (const text of [JSON.stringify(answer), JSON.stringify(wish), JSON.stringify(status)]) {
    assert.equal(text.includes(SECRET), false)
    assert.equal(text.includes(PROVIDER_TEXT), false)
    assert.equal(/authorization|bearer/i.test(text), false)
  }
}

test('the step bounds and times: 4 rounds, 8 calls, 30 s for a manual step and the same for an alarm step', () => {
  assert.equal(CLOUD_WAKE_LIMITS.rounds, 4)
  assert.equal(CLOUD_WAKE_LIMITS.calls, 8)
  assert.equal(CLOUD_WAKE_LIMITS.deadlineMs, 30000)
  assert.equal(CLOUD_WAKE_ALARM_STEP_MS, CLOUD_WAKE_LIMITS.deadlineMs)
  assert.equal(CLOUD_WAKE_ALARM_STEP_MS, WAKE_PROBE_LIMITS.maxTimeoutMs)
})

test('secret absent: provider_secret_not_configured, kept on the wish and shown by status; nothing is sent', async t => {
  const f = fixture(t, { env: { DEEPSEEK_API_KEY: undefined, CLOUD_WAKE_PROVIDER: 'deepseek' } })
  const answer = await f.step()
  await assertKept(f, answer, { status: 'failed', reason: 'provider_unavailable', cause: 'provider_secret_not_configured' })
  assert.equal(f.requests.length, 0)
  assert.equal(await f.day(), undefined)
})

test('unknown provider: provider_unknown, never swapped', async t => {
  const f = fixture(t, { env: { CLOUD_WAKE_PROVIDER: 'deepseekk' } })
  await assertKept(f, await f.step(), { status: 'failed', reason: 'provider_unavailable', cause: 'provider_unknown' })
  assert.equal(f.requests.length, 0)
})

for (const [status, expected] of [[401, { statusClass: '4xx', httpStatus: 401 }], [403, { statusClass: '4xx', httpStatus: 403 }],
  [429, { statusClass: '4xx', httpStatus: 429 }], [500, { statusClass: '5xx' }], [400, { statusClass: '4xx' }]]) {
  test(`provider answers ${status}: provider_refused with its status class, and its body never travels`, async t => {
    const f = fixture(t, { answers: [new Response(JSON.stringify({ error: PROVIDER_TEXT, key: SECRET }), { status })] })
    const answer = await f.step()
    await assertKept(f, answer, { status: 'failed', reason: 'provider_refused', cause: 'provider_refused', ...expected })
    if (!expected.httpStatus) assert.equal(Object.hasOwn(answer, 'httpStatus'), false)
  })
}

test('a provider that never answers: provider_timeout at the step deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { answers: [() => { t.mock.timers.tick(CLOUD_WAKE_LIMITS.deadlineMs); return new Promise(() => {}) }] })
  await assertKept(f, await f.step(), { status: 'failed', reason: 'cloud_wake_cancelled', cause: 'provider_timeout' })
})

test('a malformed answer: provider_answer_invalid with the closed code', async t => {
  const f = fixture(t, { answers: [new Response(`not json ${PROVIDER_TEXT}`, { status: 200 })] })
  await assertKept(f, await f.step(), { status: 'failed', cause: 'provider_answer_invalid', code: 'provider_response_invalid' })
})

test('an oversized request: request_too_large (the model\'s own 7,000-character calls of two rounds do not fit the third)', async t => {
  // Each answer stays under the 32 KiB response cap; their tool results are short refusals (a note over 2,048 bytes),
  // so nothing is clipped, and the third round's request is over 48 KiB because of the model's own calls.
  const big = 'n'.repeat(7000)
  const notes = prefix => tools(...Array.from({ length: 4 }, (_, index) => call(`${prefix}${index}`, 'wake_note', { text: big })))
  const f = fixture(t, { answers: [notes('a'), notes('b')] })
  await assertKept(f, await f.step(), { status: 'failed', reason: 'request_too_large', cause: 'request_too_large' })
  assert.equal(f.requests.length, 2)
})

test('tool results that would not fit the next request are refused with the room left, and the round goes on', async t => {
  const big = 'i'.repeat(4000)
  const f = fixture(t, { wish: running({ intent: big, acceptance: big }),
    answers: [tools(...Array.from({ length: 8 }, (_, index) => call(`c${index}`, 'inspectHeadWish'))), say('Observed what fitted.')] })
  const out = await f.step()
  assert.equal(out.status, 'success')
  assert.equal(out.toolCalls, 8)
  assert.equal(f.requests.length, 2)
  assert.ok(JSON.stringify(f.requests[1].body).length <= CLOUD_WAKE_LIMITS.requestBytes)
  const refused = out.toolRefusals.filter(item => item.code === 'cloud_wake_tool_output_too_large')
  assert.ok(refused.length >= 1 && refused.length < 8, JSON.stringify(out.toolRefusals))
  assert.ok(out.evidenceCount >= 1)
  const answers = f.requests[1].body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
  const clipped = answers.filter(answer => answer.code === 'CLOUD_WAKE_TOOL_OUTPUT_TOO_LARGE')
  assert.equal(clipped.length, refused.length)
  for (const answer of clipped) assert.ok(Number.isSafeInteger(answer.roomBytes) && answer.roomBytes >= 0 && answer.roomBytes < CLOUD_WAKE_LIMITS.requestBytes)
})

test('a refused tool: tool_refused with the tool\'s own closed code; a refused read is named on a step that succeeds', async t => {
  // A 9th call no longer fails the step: 8 run, the 9th is answered cloud_wake_tool_limit
  // and listed, and the next round must answer. A call on the 4th round still fails as tool_refused / cloud_wake_tool_limit
  // (the "the wake: a tool call returned in the 4th round" test below).
  const f = fixture(t, { answers: [tools(...Array.from({ length: 9 }, (_, index) => call(`c${index}`, 'inspectHeadWish'))), say('Inspected eight times.')] })
  const soft = await f.step()
  assert.equal(soft.status, 'success')
  assert.equal(soft.toolCalls, CLOUD_WAKE_LIMITS.calls)
  assert.deepEqual(soft.toolRefusals, [{ tool: 'inspectHeadWish', code: 'cloud_wake_tool_limit' }])
  assert.equal(f.requests[1].body.tool_choice, 'none')
  const g = fixture(t, { answers: [tools(call('x', 'writeEverything', { path: 'a' })), say('Nothing written.')] })
  const ok = await g.step()
  assert.equal(ok.status, 'success')
  assert.deepEqual(ok.toolRefusals, [{ tool: 'writeEverything', code: 'cloud_wake_tool_refused' }])
})

test('each budget: the day\'s steps, the day\'s model calls and the provider window name themselves with retryAt', async t => {
  const steps = fixture(t, { rows: [[DAY, 48]] })
  await assertKept(steps, await steps.step(), { status: 'blocked', cause: 'budget_reached', budget: 'wake_steps_per_day', retryAt: NEXT_DAY })
  const calls = fixture(t, { rows: [[`aum456:budget:v1:${JSON.stringify(['owner', 'node-main-v1'])}:day:0`, { runnerMinutes: 0, wakeModelCalls: 288, wakeExhaustionNoted: true }]] })
  const out = await calls.step()
  assert.equal(out.reason, 'wake_model_daily_limit')
  assert.equal(out.cause, 'budget_reached')
  assert.equal(out.budget, 'wake_model_calls_per_day')
  assert.equal(out.retryAt, NEXT_DAY)
  assert.equal((await calls.wish()).stepFailures.at(-1).budget, 'wake_model_calls_per_day')
  const window = fixture(t, { env: { PROVIDER_BUDGET_REQUESTS: '1' }, rows: [['provider-budget:v1:deepseek', { startedAt: 990000, requests: 1, tokens: 1 }]] })
  await assertKept(window, await window.step(), { status: 'failed', cause: 'budget_reached', budget: 'provider_window', retryAt: 990000 + 60000 })
  assert.equal(window.requests.length, 0)
})

test('a lost lease: lease_lost when the head moves during the step', async t => {
  const f = fixture(t, { answers: [({ setRow }) => { setRow('head:current', { ballId: 'c'.repeat(64), epoch: 3, entries: {} }); return Response.json({ choices: [{ message: tools(call('i', 'inspectHeadWish')) }] }) }] })
  const answer = await f.step()
  assert.equal(answer.cause, 'lease_lost')
  assert.equal((await f.wish()).stepFailures.at(-1).reason, 'lease_lost')
})

test('a tab turn running: blocked with tab_turn_running; the off switch is unchanged and writes nothing', async t => {
  const f = fixture(t, { rows: [['head:turn:active', { status: 'running', heartbeat_at: 1000000 }]] })
  await assertKept(f, await f.step(), { status: 'blocked', cause: 'tab_turn_running' })
  const off = fixture(t, { env: { WAKE_EXECUTOR_ENABLED: undefined } })
  const before = off.snapshot()
  assert.deepEqual(await off.step(), { status: 'blocked', reason: 'executor_disabled' })
  assert.deepEqual(off.snapshot(), before)
})

test('a wish keeps only its newest failures', async t => {
  const f = fixture(t, { env: { DEEPSEEK_API_KEY: undefined } })
  // Two different failures, alternating, so each is its own row (the same failure again only updates the newest row).
  const causes = []
  for (let index = 0; index < CLOUD_WAKE_FAILURES_KEPT + 3; index++) {
    f.env.CLOUD_WAKE_PROVIDER = index % 2 ? 'deepseek' : 'nope'
    causes.push((await f.step()).cause)
  }
  const kept = (await f.wish()).stepFailures
  assert.equal(kept.length, CLOUD_WAKE_FAILURES_KEPT)
  assert.deepEqual(kept.map(item => item.reason), causes.slice(-CLOUD_WAKE_FAILURES_KEPT))
  assert.deepEqual(new Set(causes), new Set(['provider_unknown', 'provider_secret_not_configured']))
})

test('a tab turn on every alarm tick never pushes the real failure out of the newest 8', async t => {
  const f = fixture(t, { answers: [new Response(JSON.stringify({ error: PROVIDER_TEXT }), { status: 401 })] })
  await f.step()
  await f.storage.put('head:turn:active', { status: 'running', heartbeat_at: 1000000 })
  for (let index = 0; index < 10; index++) assert.equal((await f.step()).cause, 'tab_turn_running')
  const kept = (await f.wish()).stepFailures
  assert.equal(kept.length, 2)
  assert.deepEqual({ reason: kept[0].reason, statusClass: kept[0].statusClass, httpStatus: kept[0].httpStatus }, { reason: 'provider_refused', statusClass: '4xx', httpStatus: 401 })
  assert.deepEqual(kept[1], { step: 1, at: f.now(), reason: 'tab_turn_running', count: 10, firstAt: f.now() })
  assert.deepEqual((await f.post({ action: 'wish_status' })).stepFailures, kept)
})

test('the closed reason never carries free text: an unknown thrown message becomes internal/unclassified', () => {
  assert.deepEqual(cloudWakeCause(new Error(`boom ${SECRET}`), { phase: 'tool' }), { cause: 'internal', where: 'tool', code: 'unclassified' })
  assert.deepEqual(cloudWakeCause({ code: 'PROVIDER_AUTH_REFUSED', status: 401, body: PROVIDER_TEXT }), { cause: 'provider_refused', statusClass: '4xx', httpStatus: 401 })
  assert.deepEqual(cloudWakeCause({ code: 'PROVIDER_REQUEST_TOO_LARGE' }), { cause: 'request_too_large' })
  assert.deepEqual(cloudWakeCause(null, { cancelled: true }), { cause: 'cancelled' })
  assert.deepEqual(cloudWakeCause(null, { timedOut: true, phase: 'tool' }), { cause: 'step_timeout' })
})

test('a manual step whose request goes away is cancelled; an alarm step stopped by its limit is a timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }) // the providers below never answer; no real timer is left behind
  const controller = new AbortController()
  const f = fixture(t, { answers: [() => { controller.abort(); return new Promise(() => {}) }] })
  const manual = await f.head.executeCloudWakeStep({ now: f.now(), signal: controller.signal })
  assert.equal(manual.cause, 'cancelled')
  const alarmController = new AbortController()
  const g = fixture(t, { answers: [() => { alarmController.abort(); return new Promise(() => {}) }] })
  const alarm = await g.head.executeCloudWakeStep({ now: g.now(), signal: alarmController.signal, via: 'alarm' })
  assert.equal(alarm.cause, 'provider_timeout')
})

test('the alarm path builds its probe with the same 30 s limit the manual step has (never the 5 s default)', async t => {
  const delays = []
  const original = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => { delays.push(ms); return original(fn, ms, ...rest) })
  const f = fixture(t, { answers: [say('Observed.')] })
  const result = await f.head.wakeStore.trigger()
  assert.equal(result.receipt.executor.status, 'probe_succeeded')
  assert.equal(delays.filter(ms => ms === 30000).length >= 2, true, `probe and step limits: ${delays}`)
  assert.equal(delays.includes(WAKE_PROBE_LIMITS.defaultTimeoutMs), false)
  assert.equal(delays.includes(15000), false)
})

test('the probe spends no step, calls no model, writes nothing, and names provider, secret NAME, model, times, counts and alarm', async t => {
  const f = fixture(t, { rows: [[DAY, 3]] })
  await f.head.wakeStore.configure({ enabled: true, intervalMs: 60000 })
  const before = f.snapshot(), writes = f.writes.length
  const { ok, probe } = await f.post({ action: 'wish_probe' })
  assert.equal(ok, true)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.writes.length, writes)
  assert.equal(f.requests.length, 0)
  assert.equal(probe.switchOn, true)
  assert.equal(probe.provider, 'deepseek')
  assert.equal(probe.ready, true)
  assert.equal(probe.secretName, 'DEEPSEEK_API_KEY')
  assert.equal(probe.secretPresent, true)
  assert.equal(probe.model, 'deepseek-chat')
  assert.deepEqual(probe.times, { manualStepMs: 30000, alarmStepMs: 30000, providerDoorMs: 120000 })
  assert.equal(probe.bounds.rounds, 4)
  assert.equal(probe.bounds.toolCalls, 8)
  assert.equal(probe.today.wakeSteps, 3)
  assert.equal(probe.today.wakeStepCap, 48)
  assert.equal(probe.today.wakeModelCalls, 0)
  assert.equal(probe.today.wakeModelCallCap, 288)
  assert.equal(probe.today.providerWindow.requestCap, 100)
  assert.equal(probe.alarm.scheduled, true)
  assert.equal(probe.wish.wish_id, 'w1')
  assert.equal(JSON.stringify(probe).includes(SECRET), false)
  const absent = fixture(t, { env: { DEEPSEEK_API_KEY: undefined, CLOUD_WAKE_PROVIDER: 'deepseek' } })
  const missing = (await absent.post({ action: 'wish_probe' })).probe
  assert.equal(missing.secretPresent, false)
  assert.equal(missing.ready, false)
  assert.equal(missing.refusal.cause, 'provider_secret_not_configured')
  assert.equal(missing.alarm.scheduled, false)
})

test('inside a real step, stagedProposal reads HEAD\'s own card record, is evidence, and is marked untrusted', async t => {
  const f = fixture(t, { answers: [tools(call('s', 'stagedProposal')), say('No card is staged.')] })
  const before = await f.wish()
  const out = await f.step()
  assert.equal(out.status, 'success')
  assert.equal(out.evidenceCount, 1)
  const toolMessage = f.requests[1].body.messages.find(message => message.role === 'tool')
  assert.deepEqual(JSON.parse(toolMessage.content), { ok: true, staged: false, mergePending: false, lastMergeOutcome: null, untrusted: true })
  assert.equal(f.requests[1].body.tools.some(tool => tool.function.name === 'stagedProposal'), true)
  assert.equal((await f.storage.get('head:staged-repo-proposal')), undefined)
  assert.equal((await f.wish()).stepsCompleted, before.stepsCompleted + 1)
})

test('rounds 1 to 3 may ask for tools, the 4th is forced to answer (tool_choice none)', async t => {
  const f = fixture(t, { answers: [tools(call('a', 'inspectHeadWish')), tools(call('b', 'inspectHeadWish')), tools(call('c', 'inspectHeadWish')), say('Observed three times.')] })
  const out = await f.step()
  assert.deepEqual(out, { status: 'success', toolCalls: 3, evidenceCount: 3 })
  assert.equal(f.requests.length, CLOUD_WAKE_LIMITS.rounds)
  assert.deepEqual(f.requests.map(request => request.body.tool_choice), ['auto', 'auto', 'auto', 'none'])
})

test('a tool call returned in the 4th round fails the step as tool_refused / cloud_wake_tool_limit', async t => {
  const f = fixture(t, { answers: [tools(call('a', 'inspectHeadWish')), tools(call('b', 'inspectHeadWish')), tools(call('c', 'inspectHeadWish')), tools(call('d', 'inspectHeadWish'))] })
  await assertKept(f, await f.step(), { status: 'failed', reason: 'tool_refused', cause: 'tool_refused', code: 'cloud_wake_tool_limit' })
  assert.equal(f.requests.length, CLOUD_WAKE_LIMITS.rounds)
  assert.equal(f.requests[3].body.tool_choice, 'none')
  assert.equal((await f.wish()).stepsCompleted, 0)
})

test('the wish_step answer carries the closed reason, also with no wish to keep it', async t => {
  const f = fixture(t, { wish: null, env: { DEEPSEEK_API_KEY: undefined, CLOUD_WAKE_PROVIDER: 'deepseek' } })
  const out = await f.post({ action: 'wish_step' })
  assert.deepEqual(out, { ok: false, probeStatus: 'failed', reason: 'provider_unavailable', cause: 'provider_secret_not_configured', wish: null })
  const g = fixture(t, { answers: [new Response(JSON.stringify({ error: PROVIDER_TEXT, key: SECRET }), { status: 429 })] })
  const refused = await g.post({ action: 'wish_step' })
  assert.equal(refused.cause, 'provider_refused')
  assert.equal(refused.statusClass, '4xx')
  assert.equal(refused.httpStatus, 429)
  assert.equal(JSON.stringify(refused).includes(SECRET), false)
  assert.equal(JSON.stringify(refused).includes(PROVIDER_TEXT), false)
})

test('a step that succeeds lists its refused reads in the wish_step answer', async t => {
  const f = fixture(t, { answers: [tools(call('x', 'writeEverything', { path: 'a' })), say('Nothing written.')] })
  const out = await f.post({ action: 'wish_step' })
  assert.equal(out.ok, true)
  assert.equal(out.probeStatus, 'success')
  assert.equal(out.toolCalls, 1)
  assert.deepEqual(out.toolRefusals, [{ tool: 'writeEverything', code: 'cloud_wake_tool_refused' }])
})

test('one step\'s reads make at most 64 GitHub requests; past that each read is refused with a closed code', async t => {
  const REPO = 'https://api.github.com/repos/your_org_x/your-node'
  const commitSha = '1'.repeat(40), treeSha = '2'.repeat(40), blobSha = '3'.repeat(40)
  const files = Array.from({ length: 100 }, (_, index) => `docs/f${String(index).padStart(3, '0')}.md`)
  const github = url => {
    if (url === `${REPO}/commits/auma%2Fsandbox%2Fwake`) return Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } })
    if (url === `${REPO}/git/trees/${treeSha}?recursive=1`) return Response.json({ sha: treeSha, truncated: false,
      tree: [{ path: 'docs', type: 'tree', mode: '040000', sha: treeSha }, ...files.map(path => ({ path, type: 'blob', mode: '100644', sha: blobSha, size: 6 }))] })
    const file = files.find(path => url === `${REPO}/contents/${path}?ref=${commitSha}`)
    if (file) return Response.json({ type: 'file', path: file, encoding: 'base64', content: Buffer.from('hello\n').toString('base64'), sha: blobSha })
    throw new Error('unexpected GitHub request ' + url)
  }
  const search = id => call(id, 'searchRepository', { query: 'zzzz', branch: 'auma/sandbox/wake' })
  const f = fixture(t, { env: { GITHUB_TOKEN: 'ghp_FIXTUREnotarealvalue0123456789abcd' }, github, answers: [tools(search('s1'), search('s2')), say('Searched.')] })
  const out = await f.step()
  assert.equal(out.status, 'success')
  assert.equal(CLOUD_WAKE_GITHUB_CALLS_PER_STEP, 64)
  assert.equal(f.githubCalls.length, CLOUD_WAKE_GITHUB_CALLS_PER_STEP)
  assert.deepEqual(out.toolRefusals, [{ tool: 'searchRepository', code: 'cloud_wake_github_calls_spent' }, { tool: 'searchRepository', code: 'cloud_wake_github_calls_spent' }])
  assert.equal(f.githubCalls.every(url => url.startsWith(REPO + '/')), true)
})
