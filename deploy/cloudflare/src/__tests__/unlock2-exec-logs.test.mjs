/** the repository reads commit 3: `exec_logs` answers for her own runs in every state (queued, running, finished). Synthetic GitHub
 * only: GitHub keeps no job log until the job has finished, so its logs endpoint answers 404 for a running job. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { handleCloudBroker, AUMA_EXEC_WORKFLOW, EXEC_LOG_NOT_READY_NEXT } from '../cloud-brokers.mjs'

const ORIGIN = 'https://fixture.example', NOW = Date.UTC(2026, 10, 16, 10, 0, 0)
const REPO = '/repos/your_org_x/your-node'
const TOKEN = 'fixture-github-credential-0123456789'
const owner = { type: 'owner', email: 'owner@fixture.example', expires: NOW / 1000 + 86400, session: 'session-repo-reads' }
const RUNS = { 21: { status: 'queued', conclusion: null }, 22: { status: 'in_progress', conclusion: null }, 23: { status: 'completed', conclusion: 'success' } }
const run = id => ({ id, name: 'Auma exec', display_title: 'auma-exec x-0123abcd @ auma/proposal/my-fix', path: AUMA_EXEC_WORKFLOW.path, ...RUNS[id],
  created_at: '2026-11-16T10:00:00Z', html_url: `https://github.com/your_org_x/your-node/actions/runs/${id}` })
const steps = [{ number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' }, { number: 2, name: 'Run her command', status: 'in_progress', conclusion: null },
  { number: 3, name: 'Upload artifacts', status: 'queued', conclusion: null }]
const jobsOf = id => id === 21 ? [] : [{ id: id * 100, run_id: id, name: 'exec', status: RUNS[id].status, conclusion: RUNS[id].conclusion, steps: id === 22 ? steps : [] }]

function door({ logs = {} } = {}) {
  const calls = []
  const env = { OWNER_EMAIL: 'owner@fixture.example', GITHUB_TOKEN: TOKEN }
  const networkFetch = async (raw, init = {}) => {
    const url = new URL(raw), path = url.pathname
    calls.push(path)
    assert.equal(init.method ?? 'GET', 'GET', 'a log read writes nothing')
    if (/\/actions\/runs\/2[123]$/.test(path)) return Response.json(run(Number(path.split('/').pop())))
    if (path === `${REPO}/actions/runs/30`) return Response.json({ ...run(23), id: 30, path: '.github/workflows/deploy-x61.yml', html_url: 'https://github.com/your_org_x/your-node/actions/runs/30' })
    if (/\/actions\/runs\/2[123]\/jobs$/.test(path)) { const id = Number(path.split('/')[6]); return Response.json({ total_count: jobsOf(id).length, jobs: jobsOf(id) }) }
    const job = /\/actions\/jobs\/(\d+)\/logs$/.exec(path)
    if (job) return logs[job[1]] ?? (job[1] === '2300' ? new Response('step one\nall done\n') : new Response('{"message":"Not Found"}', { status: 404 }))
    throw new Error('Unexpected synthetic GitHub request ' + path)
  }
  return { calls, async request(input, access = owner) {
    const response = await handleCloudBroker(new Request(ORIGIN + '/_host/repo', { method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify(input) }), env, { access, bootstrap: { ready: true, head: { seedId: '1'.repeat(64) } }, networkFetch, now: () => NOW })
    const text = await response.text()
    assert.equal(text.includes(TOKEN), false)
    return { status: response.status, value: JSON.parse(text) }
  } }
}

test('a finished run answers its log tail, as before', async () => {
  const result = await door().request({ action: 'exec_logs', run: 23 })
  assert.equal(result.status, 200, JSON.stringify(result.value))
  assert.deepEqual([result.value.run, result.value.status, result.value.jobId, result.value.log, result.value.truncated], [23, 'completed', 2300, 'step one\nall done\n', false])
})

test('a running run answers EXEC_LOG_NOT_READY with its progress, never BROKER_NOT_FOUND', async () => {
  const result = await door().request({ action: 'exec_logs', run: 22 })
  assert.equal(result.status, 409, JSON.stringify(result.value))
  assert.deepEqual(result.value, { ok: false, code: 'EXEC_LOG_NOT_READY', macFallback: false, run: 22, status: 'in_progress', conclusion: null, reason: 'log-not-published',
    jobId: 2200, jobStatus: 'in_progress', stepsDone: 1, stepsTotal: 3, currentStep: 'Run her command', next: EXEC_LOG_NOT_READY_NEXT })
})

test('a queued run with no job yet answers EXEC_LOG_NOT_READY (no-job-yet); a named job that is not there is still EXEC_JOB_NOT_FOUND', async () => {
  const fixture = door()
  const queued = await fixture.request({ action: 'exec_logs', run: 21 })
  assert.equal(queued.value.code, 'EXEC_LOG_NOT_READY', JSON.stringify(queued.value))
  assert.deepEqual([queued.value.run, queued.value.status, queued.value.reason], [21, 'queued', 'no-job-yet'])
  assert.equal(fixture.calls.some(path => path.endsWith('/logs')), false)
  assert.equal((await fixture.request({ action: 'exec_logs', run: 21, job: 5 })).value.code, 'EXEC_JOB_NOT_FOUND')
})

test('a finished run whose log GitHub has not published yet says so too', async () => {
  const result = await door({ logs: { 2300: new Response('', { status: 404 }) } }).request({ action: 'exec_logs', run: 23 })
  assert.deepEqual([result.value.code, result.value.status, result.value.jobStatus, result.value.reason], ['EXEC_LOG_NOT_READY', 'completed', 'completed', 'log-not-published'])
})

test('a run that is not hers is still refused, and a stranger reads nothing', async () => {
  const fixture = door()
  const other = await fixture.request({ action: 'exec_logs', run: 30 })
  assert.equal(other.status, 404); assert.equal(other.value.code, 'EXEC_RUN_NOT_FOUND')
  assert.equal(fixture.calls.some(path => path.includes('/jobs')), false)
  const stranger = await fixture.request({ action: 'exec_logs', run: 22 }, null)
  assert.equal(stranger.value.code, 'OWNER_SESSION_REQUIRED')
  // A log server failure other than not-found keeps its own code.
  assert.equal((await door({ logs: { 2200: new Response('', { status: 500 }) } }).request({ action: 'exec_logs', run: 22 })).value.code, 'BROKER_UPSTREAM_FAILED')
})
