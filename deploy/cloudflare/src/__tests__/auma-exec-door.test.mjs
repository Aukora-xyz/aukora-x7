/** Her exec door (cloud-brokers.mjs execDoor). Synthetic GitHub only: no network, no credential, no real run. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { handleCloudBroker, AUMA_EXEC_ACTIONS, AUMA_EXEC_LIMITS, AUMA_EXEC_WORKFLOW } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', NOW = Date.UTC(2026, 10, 14, 10, 0, 0)
const REPO = '/repos/your_org_x/your-node'
const TOKEN = 'fixture-github-credential-0123456789'
const GOOD = { ref: 'auma/proposal/my-fix', command: 'node -v && python3 -V', timeout_minutes: '10', browser: 'false', label: 'x-0123abcd' }
let sessions = 0
const ownerAccess = () => ({ type: 'owner', email: 'owner@fixture.example', expires: NOW / 1000 + 86400 * 3, session: `session-${++sessions}` })

const run = (id, extra = {}) => ({ id, name: 'Auma exec', display_title: 'auma-exec x-0123abcd @ auma/proposal/my-fix', path: AUMA_EXEC_WORKFLOW.path,
  status: 'completed', conclusion: 'success', created_at: '2026-11-14T10:00:00Z', head_branch: 'main', event: 'workflow_dispatch',
  html_url: `https://github.com/your_org_x/your-node/actions/runs/${id}`, ...extra })
const job = (id, runId) => ({ id, run_id: runId, name: 'exec', status: 'completed', conclusion: 'success', steps: [] })

/** A broker with a made-up GitHub; `answer(url, init)` may return a Response for a request, else the defaults answer. */
function broker({ access = ownerAccess(), answer, budgetAnswer, clock = { now: NOW } } = {}) {
  const calls = []
  const touched = []
  const reservations = [], order = []
  const binding = name => new Proxy({}, { get(_target, property) { touched.push(`${name}.${String(property)}`); throw new Error(`${name} touched`) } })
  // Synthetic private HEAD, separate from the GitHub transport.
  // Rate-window fixtures keep HEAD green; durable limits have their own tests.
  const head = {
    idFromName(name) { assert.equal(name, 'node-main-v1'); return name },
    get(id) {
      assert.equal(id, 'node-main-v1')
      return { async fetch(request) {
        assert.equal(request.method, 'POST')
        assert.equal(new URL(request.url).pathname, '/_head/runner-budget-v1')
        assert.match(request.headers.get('content-type'), /^application\/json/)
        assert.equal(request.headers.get('x-x6-internal-authorized'), '1')
        assert.equal(request.headers.get('x-x6-bootstrap-seed'), '1'.repeat(64))
        const input = await request.json()
        assert.deepEqual(Object.keys(input).sort(), ['minutes', 'requestHash', 'requestId'])
        assert.ok(Number.isSafeInteger(input.minutes) && input.minutes >= 1 && input.minutes <= 30)
        assert.match(input.requestId, /^[a-z0-9-]{16,64}$/)
        assert.match(input.requestHash, /^[a-f0-9]{64}$/)
        reservations.push(input); order.push('head')
        if (budgetAnswer) return await budgetAnswer(input)
        return Response.json({ ok: true, reservedMinutes: input.minutes, dispatch: true })
      } }
    },
  }
  const env = { OWNER_EMAIL: 'owner@fixture.example', GITHUB_TOKEN: TOKEN, HEAD: head, MIRROR: binding('MIRROR') }
  const networkFetch = async (raw, init = {}) => {
    const url = new URL(raw)
    order.push('github')
    calls.push({ method: init.method ?? 'GET', url, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    assert.equal(init.redirect === 'error' || init.redirect === 'manual', true)
    if (answer) { const value = await answer(url, init); if (value !== undefined) return value }
    const path = url.pathname
    if (init.method === 'POST' && path.endsWith('/dispatches')) return new Response(null, { status: 204 })
    if (path === `${REPO}/actions/workflows/auma-exec.yml/runs`) return Response.json({ total_count: 2, workflow_runs: [run(11, { status: 'in_progress', conclusion: null }), run(10)] })
    if (/\/actions\/runs\/1[01]$/.test(path)) return Response.json(run(Number(path.split('/').pop())))
    if (/\/actions\/runs\/1[01]\/jobs$/.test(path)) { const id = Number(path.split('/')[6]); return Response.json({ total_count: 1, jobs: [job(id * 100, id)] }) }
    if (/\/actions\/jobs\/1[01]00\/logs$/.test(path)) return new Response('line one\nline two\n')
    if (/\/actions\/runs\/1[01]\/artifacts$/.test(path)) return Response.json({ total_count: 1, artifacts: [{ name: 'auma-exec-artifacts', size_in_bytes: 2048, expires_at: '2026-11-17T10:00:00Z', expired: false }] })
    if (init.method === 'POST' && /\/actions\/runs\/1[01]\/cancel$/.test(path)) return new Response(null, { status: 202 })
    throw new Error('Unexpected synthetic GitHub request ' + (init.method ?? 'GET') + ' ' + path)
  }
  let approvals = 0
  const request = async input => {
    const response = await handleCloudBroker(new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json' }, body: JSON.stringify(input) }), env, { access, bootstrap: { ready: true, head: { seedId: '1'.repeat(64) } },
    networkFetch, now: () => clock.now, authorizeClass3: () => { approvals += 1; throw new Error('the exec door never asks for a passkey') } })
    const text = await response.text()
    assert.equal(text.includes(TOKEN), false, 'the GitHub credential never appears in an answer')
    return { status: response.status, value: JSON.parse(text) }
  }
  return { calls, touched, reservations, order, request, clock, approvals: () => approvals }
}
const dispatch = inputs => ({ action: 'dispatch_workflow', workflow: 'auma-exec.yml', inputs })

test('she dispatches auma-exec.yml with no passkey: valid inputs go to GitHub as strings, on main, after private HEAD admission', async () => {
  const door = broker()
  const result = await door.request(dispatch(GOOD))
  assert.equal(result.status, 200)
  assert.deepEqual(result.value, { ok: true, action: 'dispatch_workflow', workflow: 'auma-exec.yml', branch: 'main', ref: GOOD.ref, label: GOOD.label,
    runName: `auma-exec ${GOOD.label} @ ${GOOD.ref}`, timeoutMinutes: 10, browser: false, stdout: `auma-exec ${GOOD.label} dispatched on ${GOOD.ref}`, stderr: '' })
  assert.deepEqual(door.calls.map(call => [call.method, call.url.href, call.body]), [['POST', `https://api.github.com${REPO}/actions/workflows/auma-exec.yml/dispatches`,
    { ref: 'main', inputs: GOOD }]])
  assert.equal(door.approvals(), 0)
  assert.deepEqual(door.touched, [])
  assert.deepEqual(door.order, ['head', 'github'])
  assert.equal(door.reservations.length, 1)
  assert.equal(door.reservations[0].minutes, 10)
  assert.equal(door.reservations[0].requestHash,
    createHash('sha256').update(JSON.stringify({ ref: 'main', inputs: GOOD })).digest('hex'))
  // Defaults: timeout 10, browser false; numbers and booleans are accepted and sent as the strings the workflow takes.
  const plain = broker()
  const answer = await plain.request(dispatch({ ref: 'main', command: 'ls', label: 'x-abc', timeout_minutes: 30, browser: true }))
  assert.equal(answer.value.ok, true)
  assert.deepEqual(plain.calls[0].body.inputs, { ref: 'main', command: 'ls', timeout_minutes: '30', browser: 'true', label: 'x-abc' })
  const bare = broker()
  await bare.request(dispatch({ ref: 'main', command: 'ls', label: 'x-abc' }))
  assert.deepEqual(bare.calls[0].body.inputs, { ref: 'main', command: 'ls', timeout_minutes: '10', browser: 'false', label: 'x-abc' })
})

test('each invalid input is refused with its own code before anything is sent', async () => {
  const cases = [
    [{ ...GOOD, ref: 'feature/x' }, 'EXEC_REF_INVALID'], [{ ...GOOD, ref: 'auma/proposal/ab..cd' }, 'EXEC_REF_INVALID'], [{ ...GOOD, ref: undefined }, 'EXEC_REF_INVALID'],
    [{ ...GOOD, command: '' }, 'EXEC_COMMAND_INVALID'], [{ ...GOOD, command: ' \n ' }, 'EXEC_COMMAND_INVALID'], [{ ...GOOD, command: 7 }, 'EXEC_COMMAND_INVALID'],
    [{ ...GOOD, command: 'x'.repeat(AUMA_EXEC_LIMITS.commandChars + 1) }, 'EXEC_COMMAND_INVALID'], [{ ...GOOD, command: 'a\u0000b' }, 'EXEC_COMMAND_INVALID'],
    [{ ...GOOD, timeout_minutes: '0' }, 'EXEC_TIMEOUT_INVALID'], [{ ...GOOD, timeout_minutes: 31 }, 'EXEC_TIMEOUT_INVALID'], [{ ...GOOD, timeout_minutes: '5m' }, 'EXEC_TIMEOUT_INVALID'],
    [{ ...GOOD, timeout_minutes: 2.5 }, 'EXEC_TIMEOUT_INVALID'], [{ ...GOOD, browser: 'yes' }, 'EXEC_BROWSER_INVALID'], [{ ...GOOD, browser: 1 }, 'EXEC_BROWSER_INVALID'],
    [{ ...GOOD, label: '' }, 'EXEC_LABEL_INVALID'], [{ ...GOOD, label: 'a b' }, 'EXEC_LABEL_INVALID'], [{ ...GOOD, label: 'a'.repeat(65) }, 'EXEC_LABEL_INVALID'],
    [{ ...GOOD, label: undefined }, 'EXEC_LABEL_INVALID'], [{ ...GOOD, secrets: 'x' }, 'EXEC_INPUTS_INVALID'], [null, 'EXEC_INPUTS_INVALID'], [['x'], 'EXEC_INPUTS_INVALID'],
  ]
  for (const [inputs, code] of cases) {
    const door = broker()
    const result = await door.request(dispatch(inputs === null || Array.isArray(inputs) ? inputs : JSON.parse(JSON.stringify(inputs))))
    assert.deepEqual([result.status, result.value.code], [400, code], JSON.stringify(inputs)?.slice(0, 120))
    assert.equal(door.calls.length, 0)
  }
  // A field beside inputs is refused; a command that carries a credential shape never leaves.
  const extra = broker()
  assert.equal((await extra.request({ ...dispatch(GOOD), ref: 'main' })).value.code, 'BROKER_QUERY_INVALID')
  const leak = broker()
  assert.equal((await leak.request(dispatch({ ...GOOD, command: 'echo ghp_' + 'a'.repeat(36) }))).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
  assert.equal(extra.calls.length + leak.calls.length, 0)
})

test('a label or ref shaped like a credential is refused at dispatch, before anything is sent', async () => {
  for (const [inputs, code] of [[{ ...GOOD, label: 'ghp_' + 'A'.repeat(24) }, 'EXEC_LABEL_INVALID'], [{ ...GOOD, label: 'sk-proj-' + 'a'.repeat(24) }, 'EXEC_LABEL_INVALID'],
    [{ ...GOOD, label: TOKEN }, 'EXEC_LABEL_INVALID'], [{ ...GOOD, ref: 'auma/sandbox/sk-proj-' + 'a'.repeat(24) }, 'EXEC_REF_INVALID']]) {
    const door = broker()
    const result = await door.request(dispatch(inputs))
    assert.deepEqual([result.status, result.value.code], [400, code], inputs.label + ' ' + inputs.ref)
    assert.equal(door.calls.length, 0)
  }
})

test('logs: a job log over 2 MiB answers its newest lines (a rolling tail) up to a 32 MiB stream', async () => {
  const MiB = 1024 * 1024, encoder = new TextEncoder()
  /** A plain-text log of `total` bytes in 64 KiB chunks, each line 64 bytes, ending with `last`. */
  const longLog = (total, last, first = '') => {
    const line = 'x'.repeat(63) + '\n', chunk = encoder.encode(line.repeat(1024)), tail = encoder.encode(last), head = encoder.encode(first)
    let sent = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (sent === 0 && head.length) { controller.enqueue(head); sent += head.length; return }
      if (sent + chunk.length + tail.length >= total) { controller.enqueue(tail); controller.close(); return }
      controller.enqueue(chunk); sent += chunk.length
    } }))
  }
  // An earlier line with a credential shape is not in the tail, so it is neither relayed nor a reason to refuse the rest.
  const door = broker({ answer: url => url.pathname.endsWith('/logs') ? longLog(3 * MiB, 'AUMA_EXIT_CODE=1\n', 'echo ghp_' + 'A'.repeat(24) + '\n') : undefined })
  const logs = await door.request({ action: 'exec_logs', run: 10 })
  assert.equal(logs.status, 200, JSON.stringify(logs.value).slice(0, 200))
  assert.equal(logs.value.truncated, true)
  assert.match(logs.value.log, /\nAUMA_EXIT_CODE=1\n$/)
  assert.match(logs.value.log, /^x{1,63}\n(?:x{63}\n)+AUMA_EXIT_CODE=1\n$/)
  assert.ok(logs.value.log.length <= 252 * 1024)
  assert.match(logs.value.earlier, /^the earlier lines are on GitHub: https:\/\/github\.com\//)
  assert.equal(logs.value.log.includes('ghp_'), false)
  const huge = broker({ answer: url => url.pathname.endsWith('/logs') ? longLog(AUMA_EXEC_LIMITS.logStreamBytes + MiB, 'end\n') : undefined })
  const over = await huge.request({ action: 'exec_logs', run: 10 })
  assert.deepEqual([over.status, over.value.code], [413, 'BROKER_BODY_TOO_LARGE'])
})

test('only an owner session reaches the door: a caller-supplied ownerSession flag opens nothing', async () => {
  for (const access of [null, { type: 'guest', expires: NOW / 1000 + 600 }, { type: 'owner', email: 'owner@fixture.example', expires: NOW / 1000 - 1 }]) {
    for (const input of [{ ...dispatch(GOOD), ownerSession: true }, { action: 'exec_runs' }, { action: 'exec_cancel', run: 10 }]) {
      const door = broker({ access })
      const result = await door.request(input)
      assert.deepEqual([result.status, result.value.code], [403, 'OWNER_SESSION_REQUIRED'])
      assert.equal(door.calls.length, 0)
    }
  }
})

test('at most 60 dispatches an hour and 300 a UTC day per owner session; over it EXEC_RATE_LIMITED says when', async () => {
  const access = ownerAccess(), clock = { now: NOW }
  const door = broker({ access, clock })
  for (let i = 0; i < AUMA_EXEC_LIMITS.perHour; i++) { clock.now = NOW + i * 1000; assert.equal((await door.request(dispatch(GOOD))).value.ok, true) }
  clock.now = NOW + 120000
  const over = await door.request(dispatch(GOOD))
  assert.deepEqual([over.status, over.value.code, over.value.retryAt, over.value.limit], [429, 'EXEC_RATE_LIMITED', NOW + 3600000, '60 runs per hour'])
  assert.equal(door.calls.length, AUMA_EXEC_LIMITS.perHour)
  // An invalid input costs nothing and is not counted; another session has its own hour.
  assert.equal((await door.request(dispatch({ ...GOOD, label: '' }))).value.code, 'EXEC_LABEL_INVALID')
  assert.equal((await broker({ clock }).request(dispatch(GOOD))).value.ok, true)
  clock.now = NOW + 3600000
  assert.equal((await door.request(dispatch(GOOD))).value.ok, true)
  // The day: 300 in all by the UTC day, then the next midnight.
  let sent = AUMA_EXEC_LIMITS.perHour + 1
  // From the third hour on (the one sent at the hour above still counts in the second hour), 60 an hour.
  for (let hour = 2; sent < AUMA_EXEC_LIMITS.perDay; hour++) {
    for (let i = 0; i < AUMA_EXEC_LIMITS.perHour && sent < AUMA_EXEC_LIMITS.perDay; i++, sent++) {
      clock.now = NOW + hour * 3600000 + 60000 + i * 1000
      assert.equal((await door.request(dispatch(GOOD))).value.ok, true, `dispatch ${sent + 1}`)
    }
  }
  clock.now = NOW + 6 * 3600000 + 60000
  const day = await door.request(dispatch(GOOD))
  assert.deepEqual([day.status, day.value.code, day.value.retryAt, day.value.limit], [429, 'EXEC_RATE_LIMITED', Date.UTC(2026, 10, 15), '300 runs per UTC day'])
  clock.now = Date.UTC(2026, 10, 15, 0, 0, 1)
  assert.equal((await door.request(dispatch(GOOD))).value.ok, true)
})

test('list, read, logs, cancel and artifacts: no passkey, and each acts on a run of auma-exec.yml only', async () => {
  const door = broker()
  const runs = await door.request({ action: 'exec_runs', limit: 5 })
  assert.equal(runs.status, 200)
  assert.deepEqual(runs.value.runs[1], { id: 10, status: 'completed', conclusion: 'success', created: '2026-11-14T10:00:00Z', runName: 'auma-exec x-0123abcd @ auma/proposal/my-fix',
    label: 'x-0123abcd', ref: 'auma/proposal/my-fix', url: 'https://github.com/your_org_x/your-node/actions/runs/10' })
  assert.equal(door.calls[0].url.pathname + door.calls[0].url.search, `${REPO}/actions/workflows/auma-exec.yml/runs?per_page=5`)
  const one = await door.request({ action: 'exec_run', run: 10 })
  assert.deepEqual(one.value.jobs, [{ id: 1000, name: 'exec', status: 'completed', conclusion: 'success', steps: [] }])
  const logs = await door.request({ action: 'exec_logs', run: 10 })
  assert.deepEqual([logs.value.jobId, logs.value.log, logs.value.truncated], [1000, 'line one\nline two\n', false])
  assert.equal((await door.request({ action: 'exec_logs', run: 10, job: 999 })).value.code, 'EXEC_JOB_NOT_FOUND')
  const artifacts = await door.request({ action: 'exec_artifacts', run: 10 })
  assert.deepEqual(artifacts.value.artifacts, [{ name: 'auma-exec-artifacts', sizeBytes: 2048, expiresAt: '2026-11-17T10:00:00Z', expired: false }])
  const cancel = await door.request({ action: 'exec_cancel', run: 11 })
  assert.deepEqual([cancel.status, cancel.value.requested], [200, true])
  assert.deepEqual(door.calls.filter(call => call.method !== 'GET').map(call => call.url.pathname), [`${REPO}/actions/runs/11/cancel`])
  assert.equal(door.approvals(), 0)
  assert.deepEqual(door.touched, [])

  assert.equal(door.reservations.length, 0, 'reads and cancel never reserve runner minutes')
  // A run of another workflow (deploy-x61.yml) is not hers here: not read further, never cancelled.
  const foreign = broker({ answer: url => url.pathname === `${REPO}/actions/runs/12` ? Response.json(run(12, { path: '.github/workflows/deploy-x61.yml' })) : undefined })
  for (const action of ['exec_run', 'exec_logs', 'exec_cancel', 'exec_artifacts']) {
    const result = await foreign.request({ action, run: 12 })
    assert.deepEqual([result.status, result.value.code], [404, 'EXEC_RUN_NOT_FOUND'], action)
  }
  assert.deepEqual(foreign.calls.map(call => `${call.method} ${call.url.pathname}`), Array(4).fill(`GET ${REPO}/actions/runs/12`))
  // A list that names another workflow's run is a bad answer, not a run of hers.
  const mixed = broker({ answer: url => url.pathname.endsWith('/auma-exec.yml/runs') ? Response.json({ total_count: 1, workflow_runs: [run(13, { path: '.github/workflows/proposal-gate.yml' })] }) : undefined })
  assert.equal((await mixed.request({ action: 'exec_runs' })).value.code, 'BROKER_RESPONSE_INVALID')
  // A finished run cannot be cancelled; a bad run id or field never reaches GitHub.
  const done = broker({ answer: url => url.pathname.endsWith('/cancel') ? new Response(null, { status: 409 }) : undefined })
  assert.equal((await done.request({ action: 'exec_cancel', run: 10 })).value.code, 'EXEC_RUN_NOT_CANCELLABLE')
  const shape = broker()
  for (const [input, code] of [[{ action: 'exec_run', run: '10' }, 'EXEC_RUN_INVALID'], [{ action: 'exec_run', run: 0 }, 'EXEC_RUN_INVALID'],
    [{ action: 'exec_logs', run: 10, job: -1 }, 'EXEC_JOB_INVALID'], [{ action: 'exec_run', run: 10, job: 1 }, 'BROKER_QUERY_INVALID'],
    [{ action: 'exec_runs', limit: 21 }, 'EXEC_LIMIT_INVALID'], [{ action: 'exec_runs', branch: 'main' }, 'BROKER_QUERY_INVALID']]) {
    assert.equal((await shape.request(input)).value.code, code, JSON.stringify(input))
  }
  assert.equal(shape.calls.length, 0)
  assert.deepEqual([...AUMA_EXEC_ACTIONS], ['exec_runs', 'exec_run', 'exec_logs', 'exec_cancel', 'exec_artifacts'])
})

test('the reads voice may call (exec_runs, exec_run, exec_artifacts) send only GETs of this repository and touch no storage', async () => {
  for (const input of [{ action: 'exec_runs' }, { action: 'exec_run', run: 10 }, { action: 'exec_artifacts', run: 10 }]) {
    const door = broker()
    assert.equal((await door.request(input)).value.ok, true)
    assert.ok(door.calls.length >= 1)
    for (const call of door.calls) {
      assert.equal(call.method, 'GET')
      assert.equal(call.url.origin + call.url.pathname.slice(0, REPO.length), 'https://api.github.com' + REPO)
    }
    assert.deepEqual(door.touched, [])
  }
})

test('every other workflow keeps today\'s rule exactly: a passkey, and deploy-x61.yml still dispatches as before', async () => {
  for (const workflow of ['proposal-gate.yml', 'rollback-x61.yml', 'observe-x61.yml', 'AUMA-EXEC.yml', 'auma-exec.yaml']) {
    const door = broker()
    const result = await door.request({ action: 'dispatch_workflow', workflow, inputs: GOOD })
    assert.deepEqual([result.status, result.value.code, result.value.tier], [403, 'CLASS3_WEBAUTHN_REQUIRED', 'T2'], workflow)
    assert.equal(door.calls.length, 0)
  }
  const deploy = broker()
  const result = await deploy.request({ action: 'dispatch_workflow' })
  assert.deepEqual(result.value, { ok: true, action: 'dispatch_workflow', workflow: 'deploy-x61.yml', branch: 'main' })
  assert.deepEqual(deploy.calls.map(call => [call.method, call.url.pathname, call.body]), [['POST', `${REPO}/actions/workflows/deploy-x61.yml/dispatches`, { ref: 'main' }]])
})

test('a credential that comes back in a GitHub answer is withheld, never relayed: a run name only for that run', async () => {
  // Review: one run name the screen refuses withholds that name alone; the rest of her list still answers.
  for (const title of [`auma-exec ${TOKEN} @ main`, 'auma-exec ghp_' + 'A'.repeat(24) + ' @ main', 'auma-exec sk-proj-' + 'a'.repeat(24) + ' @ main']) {
    const door = broker({ answer: url => url.pathname.endsWith('/auma-exec.yml/runs')
      ? Response.json({ total_count: 2, workflow_runs: [run(11), run(10, { display_title: title })] }) : undefined })
    const result = await door.request({ action: 'exec_runs' })
    assert.deepEqual([result.status, result.value.ok], [200, true], title)
    assert.deepEqual(result.value.runs[1], { id: 10, status: 'completed', conclusion: 'success', created: '2026-11-14T10:00:00Z', runName: null,
      label: null, ref: null, url: 'https://github.com/your_org_x/your-node/actions/runs/10', runNameWithheld: true })
    assert.equal(result.value.runs[0].label, 'x-0123abcd')
    assert.equal(JSON.stringify(result.value).includes(title.split(' ')[1]), false)
  }
  const logs = broker({ answer: url => url.pathname.endsWith('/logs') ? new Response(`echo ${TOKEN}\n`) : undefined })
  assert.equal((await logs.request({ action: 'exec_logs', run: 10 })).value.code, 'BROKER_PRIVATE_CONTENT_REFUSED')
})

test('YOURTEAM-456: HEAD daily ceiling carries UTC retryAt and stops dispatch', async () => {
  const retryAt = Date.UTC(2026, 10, 15)
  const door = broker({ budgetAnswer: () => Response.json({ ok: false, code: 'EXEC_RATE_LIMITED', retryAt }, { status: 429 }) })
  const result = await door.request(dispatch(GOOD))
  assert.deepEqual([result.status, result.value.code, result.value.retryAt], [429, 'EXEC_RATE_LIMITED', retryAt])
  assert.equal(door.reservations.length, 1)
  assert.equal(door.calls.length, 0)
  assert.deepEqual(door.order, ['head'])
})

test('YOURTEAM-456: unavailable HEAD stops before dispatch and is not automatically retried', async () => {
  const door = broker({ budgetAnswer: () => Response.json({ ok: false, code: 'EXEC_BUDGET_UNAVAILABLE' }, { status: 503 }) })
  const result = await door.request(dispatch(GOOD))
  assert.deepEqual([result.status, result.value.code], [503, 'EXEC_BUDGET_UNAVAILABLE'])
  assert.equal(door.reservations.length, 1)
  assert.equal(door.calls.length, 0)
})
