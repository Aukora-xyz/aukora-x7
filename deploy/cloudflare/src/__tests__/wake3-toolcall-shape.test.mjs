/** DeepSeek's deepseek-chat puts `index` on every element of `tool_calls`. Every wake step on that
 * provider failed at step 1 with tool_refused / cloud_wake_tool_invalid before any tool ran. The door now projects each
 * call to the closed shape `{ id, type, function }` when its `index` is a safe integer >= 0 and it has no other key; HEAD's
 * closed check in executeCloudWakeStep stays the one judge of everything else. Synthetic storage, provider and GitHub only. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { X61HeadDurableObject } from '../head-do.mjs'
import { sendCloudModelRequest, prepareCloudModelRequest } from '../cloud-model-door.mjs'
import { providerBudgetLimits, providerRequestReservation } from '../provider-budget.mjs'

const SEED = 'a'.repeat(64), BALL = 'b'.repeat(64)
const SECRET = 'synthetic-provider-value-wake3b'
const GH = 'ghp_FIXTUREnotarealvalue0123456789abcd'
const REPO = 'https://api.github.com/repos/your_org_x/your-node'
const sha = n => String(n).repeat(40).slice(0, 40)
const ENV = { DEEPSEEK_API_KEY: SECRET, CLOUD_WAKE_PROVIDER: 'deepseek', GITHUB_TOKEN: GH, PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '100',
  PROVIDER_BUDGET_TOKENS: '10000000', PROVIDER_MAX_OUTPUT_TOKENS: '400', WAKE_EXECUTOR_ENABLED: '1' }

/** One element of `tool_calls` exactly as deepseek-chat sends it (live, 2026-11-14): index first, then id, type, function. */
const dsCall = (index, id, name, args = {}) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
/** A whole deepseek-chat answer that asks for tools: content '' and finish_reason tool_calls, as the live provider sends. */
const deepseekTools = (...calls) => Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'deepseek-chat',
  choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: calls }, logprobs: null, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
const deepseekSay = content => Response.json({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'deepseek-chat',
  choices: [{ index: 0, message: { role: 'assistant', content }, logprobs: null, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })
const closed = call => ({ id: call.id, type: call.type, function: call.function })

/** A fake GitHub for her two own reads; counts each read so a dispatch is seen once per call. */
function github() {
  const seen = { branches: 0, runs: 0, other: [] }
  const answer = url => {
    if (url === 'https://api.github.com/graphql') {
      seen.branches++
      return Response.json({ data: { repository: { refs: { totalCount: 1, nodes: [{ name: 'sandbox/wake', target: { oid: sha(1) }, compare: { aheadBy: 1, behindBy: 2 } }] } } } })
    }
    if (url === `${REPO}/actions/workflows/auma-exec.yml/runs?per_page=20`) {
      seen.runs++
      return Response.json({ total_count: 1, workflow_runs: [{ id: 5, path: '.github/workflows/auma-exec.yml', status: 'completed', conclusion: 'success',
        created_at: '2026-11-14T01:00:00Z', html_url: `https://github.com/your_org_x/your-node/actions/runs/5`, display_title: 'auma-exec probe-5 @ auma/sandbox/wake' }] })
    }
    seen.other.push(url)
    throw new Error('unexpected GitHub request ' + url)
  }
  return { seen, answer }
}

function fixture(t, { answers = [], wish = { wish_id: 'w1', intent: 'Look at my own work', acceptance: 'Two reads recorded', status: 'running', stepsCompleted: 0, maxSteps: 6 } } = {}) {
  const now = 1000000
  let rows = new Map([['bootstrap:v1', { phase: 'complete', seedId: SEED }], ['head:current', { ballId: BALL, epoch: 2, entries: {} }], ['head:wish:active', wish]])
  let alarm = null, tail = Promise.resolve()
  const view = (data, timer) => ({
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => { data.delete(key) },
    list: async ({ prefix = '', limit = Infinity } = {}) => structuredClone(new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit))),
    getAlarm: async () => timer.value,
    setAlarm: async value => { timer.value = value },
    deleteAlarm: async () => { timer.value = null },
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
  t.mock.method(Date, 'now', () => now)
  const hub = github(), requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://api.github.com/')) return hub.answer(String(url), init)
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
    requests.push({ text: init.body, body: JSON.parse(init.body) })
    const answer = answers.shift()
    assert.notEqual(answer, undefined, 'Unexpected provider round')
    return answer
  })
  const env = { ...ENV }
  const head = new X61HeadDurableObject({ storage, getWebSockets: () => [] }, env)
  t.after(() => head.wakeStore.dispose())
  head.broadcast = async () => {}
  const transcript = () => [...rows].filter(([key]) => key.startsWith('head:transcript:row:')).map(([, row]) => row)
  return { head, env, requests, hub, transcript, wish: () => storage.get('head:wish:active'), step: () => head.executeCloudWakeStep({ now }) }
}

/** Round 2's request, as the provider would see it: its assistant turn carries the closed calls, each answered by id. */
function assertRoundTwo(f, calls) {
  assert.equal(f.requests.length, 2)
  const sent = f.requests[1].body.messages
  const assistant = sent.find(message => message.role === 'assistant' && Array.isArray(message.tool_calls))
  assert.deepEqual(assistant.tool_calls, calls.map(closed))
  for (const call of assistant.tool_calls) assert.equal(Object.hasOwn(call, 'index'), false)
  assert.deepEqual(sent.filter(message => message.role === 'tool').map(message => message.tool_call_id), calls.map(call => call.id))
  // The reservation HEAD makes before it sends accepts that exact body (provider-budget's closed `only(call, [id, type, function])`).
  const reservation = providerRequestReservation(new TextEncoder().encode(f.requests[1].text), providerBudgetLimits(f.env), '/chat/completions', { assistantReasoning: true })
  assert.equal(reservation.requestedModel, 'deepseek-chat')
  // The stored turn is closed too: the transcript's assistant row never carries `index`.
  const stored = f.transcript().filter(row => row.role === 'assistant').map(row => { try { return JSON.parse(row.content) } catch { return null } }).find(value => value?.tool_calls)
  assert.deepEqual(stored.tool_calls, calls.map(closed))
}

test('the live shape: one call with index 0 and id call_00_abc runs its tool once and the step succeeds', async t => {
  const one = dsCall(0, 'call_00_abc', 'listMyBranches')
  const f = fixture(t, { answers: [deepseekTools(one), deepseekSay('I have one branch.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.equal(out.toolCalls, 1)
  assert.equal(Object.hasOwn(out, 'toolRefusals'), false)
  assert.equal(f.hub.seen.branches, 1)
  assertRoundTwo(f, [one])
  assert.equal((await f.wish()).stepsCompleted, 1)
})

test('two parallel calls with index 0 and 1: each tool runs once, each answer carries its own id', async t => {
  const calls = [dsCall(0, 'call_00_aaa', 'listMyBranches'), dsCall(1, 'call_01_bbb', 'execRuns')]
  const f = fixture(t, { answers: [deepseekTools(...calls), deepseekSay('Branches and runs read.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.equal(out.toolCalls, 2)
  assert.deepEqual([f.hub.seen.branches, f.hub.seen.runs], [1, 1])
  assertRoundTwo(f, calls)
})

test('an id with a colon (call_0:0, as some OpenAI-wire providers send) is accepted and answered by that id', async t => {
  const one = dsCall(0, 'call_0:0', 'listMyBranches')
  const f = fixture(t, { answers: [deepseekTools(one), deepseekSay('Read.')] })
  const out = await f.step()
  assert.equal(out.status, 'success', JSON.stringify(out))
  assert.equal(f.hub.seen.branches, 1)
  assertRoundTwo(f, [one])
})

for (const [label, calls] of [
  ['an extra unknown key (foo)', [{ ...dsCall(0, 'call_00_abc', 'listMyBranches'), foo: 1 }]],
  ['index -1', [dsCall(-1, 'call_00_abc', 'listMyBranches')]],
  ['index "0" (a string)', [dsCall('0', 'call_00_abc', 'listMyBranches')]],
  ['index 1.5', [dsCall(1.5, 'call_00_abc', 'listMyBranches')]],
  ['a duplicate id', [dsCall(0, 'call_00_abc', 'listMyBranches'), dsCall(1, 'call_00_abc', 'execRuns')]],
  ['an id with a space', [dsCall(0, 'call 00', 'listMyBranches')]],
  ['an id with a quote', [dsCall(0, 'call"00', 'listMyBranches')]],
  ['a missing id', [(({ id: _id, ...rest }) => rest)(dsCall(0, 'x', 'listMyBranches'))]],
  ['a wrong type', [{ ...dsCall(0, 'call_00_abc', 'listMyBranches'), type: 'tool' }]],
  ['an extra key inside function', [{ ...dsCall(0, 'call_00_abc', 'listMyBranches'), function: { name: 'listMyBranches', arguments: '{}', extra: 1 } }]],
]) {
  test(`still refused closed: ${label}; no tool runs and the step fails as tool_refused / cloud_wake_tool_invalid`, async t => {
    const f = fixture(t, { answers: [deepseekTools(...calls)] })
    const out = await f.step()
    assert.equal(out.status, 'failed')
    assert.equal(out.cause, 'tool_refused')
    assert.equal(out.code, 'cloud_wake_tool_invalid')
    assert.equal(f.requests.length, 1)
    assert.deepEqual([f.hub.seen.branches, f.hub.seen.runs], [0, 0])
    const wish = await f.wish()
    assert.equal(wish.stepsCompleted, 0)
    assert.equal(wish.stepFailures.at(-1).code, 'cloud_wake_tool_invalid')
  })
}

test('still refused: an unknown tool name runs nothing and is named with its closed code', async t => {
  const f = fixture(t, { answers: [deepseekTools(dsCall(0, 'call_00_abc', 'writeEverything', { path: 'a' })), deepseekSay('Nothing written.')] })
  const out = await f.step()
  assert.equal(out.status, 'success')
  assert.deepEqual(out.toolRefusals, [{ tool: 'writeEverything', code: 'cloud_wake_tool_refused' }])
  assert.deepEqual([f.hub.seen.branches, f.hub.seen.runs], [0, 0])
  assert.equal(JSON.parse(f.requests[1].body.messages.find(message => message.role === 'tool').content).code, 'CLOUD_WAKE_TOOL_REFUSED')
})

test('a full 2-step read-only wish on the fake DeepSeek: listMyBranches, then execRuns; two step rows, no failures', async t => {
  const f = fixture(t, { answers: [
    deepseekTools(dsCall(0, 'call_00_s1', 'listMyBranches')), deepseekSay('Step 1: one branch, auma/sandbox/wake.'),
    deepseekTools(dsCall(0, 'call_00_s2', 'execRuns')), deepseekSay('Step 2: one runner job, completed.'),
  ] })
  const first = await f.step()
  assert.equal(first.status, 'success', JSON.stringify(first))
  const second = await f.step()
  assert.equal(second.status, 'success', JSON.stringify(second))
  const wish = await f.wish()
  assert.equal(wish.stepsCompleted, 2)
  assert.equal(wish.status, 'running')
  assert.deepEqual(wish.steps.map(row => [row.step, row.toolCalls]), [[1, 1], [2, 1]])
  assert.equal(wish.stepFailures === undefined || wish.stepFailures.length === 0, true, JSON.stringify(wish.stepFailures))
  assert.deepEqual([f.hub.seen.branches, f.hub.seen.runs], [1, 1])
  assert.equal(f.hub.seen.other.length, 0)
  assert.equal(JSON.stringify(wish).includes(SECRET), false)
})

test('the door itself: a valid index is dropped, anything else is passed on unchanged for HEAD to judge', async () => {
  const prepared = prepareCloudModelRequest({ env: ENV, provider: 'deepseek', messages: [{ role: 'user', content: 'hi' }] })
  const send = async (...calls) => (await sendCloudModelRequest(prepared, { env: ENV, fetchImpl: async () => deepseekTools(...calls) })).message.tool_calls
  const good = dsCall(3, 'call_03', 'listMyBranches')
  assert.deepEqual(await send(good), [closed(good)])
  for (const bad of [{ ...good, foo: 1 }, dsCall(-1, 'c', 'x'), dsCall('0', 'c', 'x'), dsCall(Number.MAX_SAFE_INTEGER + 1, 'c', 'x')]) {
    assert.deepEqual(await send(bad), [bad])
  }
  // A call already in the closed shape is passed on as it is.
  assert.deepEqual(await send(closed(good)), [closed(good)])
  // Without the projection, provider-budget refuses the replayed turn: the reason the shape must be closed here.
  const replay = JSON.stringify({ model: 'deepseek-chat', stream: false, max_tokens: 400, messages: [{ role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [good] }, { role: 'tool', tool_call_id: good.id, content: '{}' }] })
  assert.throws(() => providerRequestReservation(new TextEncoder().encode(replay), providerBudgetLimits(ENV), '/chat/completions', { assistantReasoning: true }))
})
