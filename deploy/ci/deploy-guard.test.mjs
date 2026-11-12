// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/deploy-guard.test.mjs  (no network: every transport is injected)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEPLOY_INERT_GLOBS, isDeployInertRepoPath, matchesDeployInertGlob } from './deploy-paths.mjs'
import { awaitLive, boundedGet, configuredAccount, edgeReachable, main, observeTarget, parseBuildSha, previousVersion, signinPageRenders, supersededBy, watchReport, watchVerdict,
  AWAIT_LIVE_CEILING_MS, BY_HAND, LIVE_BEHIND_ALLOWANCE_MS, LIVE_WAIT, ORIGIN, PUBLISH_STEP, WATCH_COMMIT_LIMIT, WATCH_PRESENCE_READS } from './deploy-guard.mjs'
import * as guard from './deploy-guard.mjs'

const SHA = 'c'.repeat(40)
const OTHER = 'd'.repeat(40)
const VERSION = '0f0e0d0c-0b0a-4908-8706-050403020100'
const SIGNIN = '<!doctype html><html><head><title>Owner sign-in</title></head><body><button id="passkey-submit" type="button" disabled>Sign in with passkey</button></body></html>'

test('deploy-inert paths: only Markdown at the root and under docs/', () => {
  assert.deepEqual([...DEPLOY_INERT_GLOBS], ['*.md', 'docs/*.md', 'docs/**/*.md'])
  for (const path of ['README.md', 'NORTH-STAR.md', 'AGENTS.md', 'docs/a.md', 'docs/plan/x/y.md']) {
    assert.equal(matchesDeployInertGlob(path), true, path)
    assert.equal(isDeployInertRepoPath(path), true, path)
  }
  for (const path of ['apps/web/src/main.tsx', 'packages/client/ui-layout/src/x.ts', 'deploy/cloudflare/src/worker.mjs',
    'server/build-preview.mjs', 'mirror/home/auma/COVENANT.md', 'mirror/home/balls/HEAD.json', 'docs/persistence-schema.json',
    'package.json', '.github/workflows/deploy-x61.yml', 'apps/web/README.md', 'docs', 'docs/', '', null, 42]) {
    assert.equal(matchesDeployInertGlob(path), false, String(path))
    assert.equal(isDeployInertRepoPath(path), false, String(path))
  }
  // The broker's strict form never admits a non-canonical spelling the glob form might.
  for (const path of ['docs/../server/x.md', 'docs/./a.md', 'docs//a.md', 'docs/a b.md', 'docs/a%2e.md', 'docs\\a.md', '/README.md', 'docs/a.md\n']) {
    assert.equal(isDeployInertRepoPath(path), false, JSON.stringify(path))
  }
})

test('the removed cleverness stays removed: no history arithmetic, no automatic rollback', () => {
  for (const name of ['historyDecision', 'historyInput', 'commitRelease', 'releaseRange', 'publishedVersion', 'rollbackDecision', 'HISTORY_COMMIT_LIMIT']) {
    assert.equal(Object.hasOwn(guard, name), false, name)
  }
  const source = readFileSync(new URL('./deploy-guard.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /release-range|decide-history|HEAD_SYNC_COPY_ONLY|rollback-decision|published-version|mirrorCopyRefusals/)
})

test('previous version: exactly one version at 100%, else nothing to name for a rollback and no deploy', () => {
  assert.equal(previousVersion(JSON.stringify({ id: 'x', versions: [{ version_id: VERSION, percentage: 100 }] })), VERSION)
  assert.equal(previousVersion(`warning line\n${JSON.stringify({ versions: [{ version_id: VERSION, percentage: 100 }] })}\n`), VERSION)
  for (const text of ['', 'not json', '{}', JSON.stringify({ versions: [] }),
    JSON.stringify({ versions: [{ version_id: VERSION, percentage: 50 }, { version_id: VERSION, percentage: 50 }] }),
    JSON.stringify({ versions: [{ version_id: VERSION, percentage: 99 }] }),
    JSON.stringify({ versions: [{ version_id: 'v1; rm -rf /', percentage: 100 }] })]) {
    assert.throws(() => previousVersion(text), { code: 'PREVIOUS_VERSION_UNRECORDABLE' }, text)
  }
})

test('build revision: /api/build must name exactly one 40-hex commit', () => {
  assert.equal(parseBuildSha(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, buildSha: SHA })), SHA)
  assert.equal(parseBuildSha(200, 'application/json', JSON.stringify({ sourceRevision: SHA.toUpperCase() })), SHA)
  assert.equal(parseBuildSha(200, 'application/json', JSON.stringify({ buildSha: SHA, sourceRevision: SHA })), SHA)
  assert.equal(parseBuildSha(200, 'text/plain', `${SHA}\n`), SHA)
  for (const [status, type, body] of [[200, 'application/json', JSON.stringify({ buildSha: 'UNVERIFIED' })],
    [200, 'application/json', JSON.stringify({ buildSha: SHA, sourceRevision: OTHER })], [200, 'application/json', JSON.stringify({ ok: true })],
    [200, 'application/json', '[]'], [200, 'application/json', 'nope'], [401, 'application/json', JSON.stringify({ buildSha: SHA })],
    [200, 'text/html', SHA], [200, 'text/plain', SHA.slice(0, 7)], [200, 'application/json', JSON.stringify({ buildSha: SHA.slice(0, 7) })]]) {
    assert.equal(parseBuildSha(status, type, body), null, `${status} ${type} ${body}`)
  }
})

test('sign-in page: 401 HTML with the owner sign-in title and the passkey button', () => {
  assert.equal(signinPageRenders(401, 'text/html; charset=utf-8', SIGNIN), true)
  assert.equal(signinPageRenders(200, 'text/html', SIGNIN), false)
  assert.equal(signinPageRenders(401, 'application/json', SIGNIN), false)
  assert.equal(signinPageRenders(401, 'text/html', SIGNIN.replace('passkey-submit', 'other')), false)
  assert.equal(signinPageRenders(401, 'text/html', '{"ok":false,"code":"OWNER_ACCESS_REQUIRED"}'), false)
})

function liveFixture(responses, { latencyMs = 0 } = {}) {
  let clock = 0, index = 0
  const requests = []
  return {
    requests,
    now: () => clock,
    sleep: async ms => { clock += ms },
    get: async (path, headers, ms) => {
      requests.push({ path, headers, ms })
      const step = responses[Math.min(index, responses.length - 1)]
      if (path === '/') index += 1
      // A slow answer costs its latency, but never more than the deadline the guard gave this request.
      clock += Math.min(latencyMs, ms)
      if (latencyMs > ms) throw Object.assign(new Error('DEADLINE'), { answered: true })
      const answer = step[path]
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}
const good = { '/api/build': { status: 200, contentType: 'application/json', body: JSON.stringify({ buildSha: SHA }) }, '/': { status: 401, contentType: 'text/html', body: SIGNIN } }
const stale = { ...good, '/api/build': { status: 200, contentType: 'application/json', body: JSON.stringify({ buildSha: OTHER }) } }
const broken = { ...good, '/': { status: 500, contentType: 'text/html', body: 'error' } }
const limits = { timeoutMs: 60_000, intervalMs: 5_000, needed: 3, requestTimeoutMs: 15_000 }

test('await-live: three consecutive good reads within the bound', async () => {
  const fx = liveFixture([stale, stale, good, good, good])
  const result = await awaitLive({ expectedSha: SHA, ...fx, limits })
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 5)
  assert.deepEqual(fx.requests[1], { path: '/', headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, ms: 15_000 })
  // A flap resets the streak.
  const flap = liveFixture([good, good, broken, good, good, good])
  assert.equal((await awaitLive({ expectedSha: SHA, ...flap, limits })).attempts, 6)
})

test('await-live: a commit that never shows, a broken sign-in page or a dead origin ends within the absolute budget', async () => {
  for (const [responses, code, answered] of [[[stale], 'BUILD_NOT_LIVE', true], [[broken], 'SIGNIN_PAGE_NOT_RENDERED', true],
    [[{ '/api/build': new Error('down'), '/': new Error('down') }], 'NO_ANSWER', false]]) {
    const fx = liveFixture(responses)
    const result = await awaitLive({ expectedSha: SHA, ...fx, limits })
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.equal(result.answered, answered)
    assert.ok(fx.now() <= limits.timeoutMs, 'bounded')
    assert.equal(result.attempts, limits.timeoutMs / limits.intervalMs)
  }
  const fx = liveFixture([good])
  assert.equal((await awaitLive({ expectedSha: 'abc', ...fx, limits })).code, 'EXPECTED_SHA_INVALID')
  assert.equal(fx.requests.length, 0)
})

test('await-live: a Worker that answers slowly cannot stretch the budget: no request outlives what is left of it', async () => {
  const fx = liveFixture([good], { latencyMs: 600_000 })
  const result = await awaitLive({ expectedSha: SHA, ...fx, limits })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BUILD_NOT_LIVE')
  assert.equal(result.answered, true, 'a status line that never finished is the site, not the observer')
  assert.ok(fx.now() <= limits.timeoutMs, `ended at ${fx.now()} ms`)
  for (const request of fx.requests) assert.ok(request.ms > 0 && request.ms <= limits.requestTimeoutMs)
  assert.ok(AWAIT_LIVE_CEILING_MS < 5 * 60_000, 'the process ceiling fits inside the confirm step timeout')
  assert.equal(LIVE_WAIT.timeoutMs + LIVE_WAIT.requestTimeoutMs + LIVE_WAIT.controlTimeoutMs < AWAIT_LIVE_CEILING_MS, true)
})

/** A local server that sends headers, then one byte every 100 ms, forever (until the client hangs up). */
async function tricklingServer() {
  const timers = new Set()
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    const timer = setInterval(() => response.write(' '), 100)
    timers.add(timer)
    request.on('close', () => { clearInterval(timer); timers.delete(timer) })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => { for (const timer of timers) clearInterval(timer); server.closeAllConnections(); return new Promise(done => server.close(done)) } }
}

test('boundedGet: the deadline is absolute, so a trickling body ends on time and counts as the site answering', async () => {
  const server = await tricklingServer()
  try {
    const started = Date.now()
    await assert.rejects(boundedGet('/api/build', {}, 700, { request: httpRequest, origin: server.origin }), error => error.message === 'DEADLINE' && error.answered === true)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 650 && elapsed < 3_000, `took ${elapsed} ms`)
    await assert.rejects(boundedGet('https://elsewhere.example/api/build', {}, 700, { request: httpRequest, origin: server.origin }), /ORIGIN_REFUSED/)
  } finally { await server.close() }
})

test('boundedGet: an origin that never answers is not the site answering', async () => {
  const server = createServer(() => {})
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  try {
    await assert.rejects(boundedGet('/', {}, 300, { request: httpRequest, origin: `http://127.0.0.1:${server.address().port}` }), error => error.message === 'DEADLINE' && error.answered === false)
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)) }
})

test('edge control: only a Cloudflare trace answer counts as the edge being reachable', async () => {
  assert.equal(await edgeReachable(async () => ({ status: 200, body: 'fl=1\nh=node.example.invalid\ncolo=SIN\n' })), true)
  assert.equal(await edgeReachable(async () => ({ status: 200, body: '<html>' })), false)
  assert.equal(await edgeReachable(async () => { throw new Error('DEADLINE') }), false)
})

test('the guard pins its origin and reads the account from wrangler.toml', () => {
  assert.equal(ORIGIN, 'https://node.example.invalid')
  const toml = readFileSync(new URL('../cloudflare/wrangler.toml', import.meta.url), 'utf8')
  assert.match(configuredAccount(toml), /^[0-9a-f]{32}$/)
  assert.equal(configuredAccount('account_id = "abc"'), null)
  assert.equal(configuredAccount(`account_id = "${'a'.repeat(32)}"\naccount_id = "${'b'.repeat(32)}"`), null)
})

const HEAD = 'e'.repeat(40)
const SIDE = 'f'.repeat(40)

test('superseded: only a live build that descends from the observed commit AND is main\'s head or an ancestor of it makes an observation not count (review loop3 S5)', async () => {
  // compare(target, live) answers `first`; compare(live, head) answers `second`.
  const compare = (first, second = 'ahead') => async base => ({ status: base === SHA ? first : second })
  assert.equal(await supersededBy({ target: SHA, live: OTHER, head: OTHER, compare: compare('ahead', 'never asked') }), OTHER)
  assert.equal(await supersededBy({ target: SHA, live: OTHER, head: HEAD, compare: compare('ahead', 'ahead') }), OTHER)
  // A feature-branch commit published from elsewhere: it descends from the observed commit but never reached main.
  for (const second of ['diverged', 'behind', 'identical']) {
    assert.equal(await supersededBy({ target: SHA, live: OTHER, head: HEAD, compare: compare('ahead', second) }), null, second)
  }
  for (const [live, cmp] of [[OTHER, compare('behind')], [OTHER, compare('diverged')], [OTHER, compare('identical')], [SHA, compare('ahead')], [null, compare('ahead')], ['x', compare('ahead')],
    [OTHER, async () => { throw new Error('gh failed') }]]) {
    assert.equal(await supersededBy({ target: SHA, live, head: OTHER, compare: cmp }), null, String(live))
  }
  for (const head of [null, 'nope', undefined]) assert.equal(await supersededBy({ target: SHA, live: OTHER, head, compare: compare('ahead') }), null, String(head))
})

/** A temporary GITHUB_OUTPUT / GITHUB_STEP_SUMMARY pair. */
function stepFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'x61-guard-step-'))
  const output = join(dir, 'output'), summary = join(dir, 'summary')
  const read = file => { try { return readFileSync(file, 'utf8') } catch { return '' } }
  return { output, summary, readOutput: () => read(output), readSummary: () => read(summary), done: () => rmSync(dir, { recursive: true, force: true }) }
}
const buildAnswer = sha => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ buildSha: sha }) })

test('superseded CLI: writes the step output and summary only when superseded, else exits 1 so the failure stands (signed-in and signed-out alike)', async () => {
  const files = stepFiles()
  try {
    const env = { X61_EXPECT_BUILD_SHA: SHA, GITHUB_REPOSITORY: 'synthetic/repo', GITHUB_OUTPUT: files.output, GITHUB_STEP_SUMMARY: files.summary }
    const paths = []
    const gh = path => { paths.push(path); return path === 'repos/synthetic/repo/commits/main' ? { sha: OTHER } : { status: 'ahead' } }
    assert.equal(await main(['superseded', 'signed-in'], env, { gh, get: async () => buildAnswer(OTHER) }), 0)
    assert.deepEqual(paths, ['repos/synthetic/repo/commits/main', `repos/synthetic/repo/compare/${SHA}...${OTHER}`])
    assert.equal(files.readOutput(), `superseded=${OTHER}\n`)
    assert.match(files.readSummary(), new RegExp(`SUPERSEDED: the live build is now ${OTHER}, a newer commit on main, so this signed-in observation of ${SHA} counts neither way`))
    const onMain = status => path => path === 'repos/synthetic/repo/commits/main' ? { sha: OTHER } : { status }
    for (const [get, ghFor] of [[async () => buildAnswer(SHA), onMain('ahead')], [async () => buildAnswer(OTHER), onMain('behind')], [async () => { throw new Error('down') }, onMain('ahead')],
      // Live OTHER descends from SHA, but main's head is HEAD and OTHER is not an ancestor of it: not on main.
      [async () => buildAnswer(OTHER), path => path === 'repos/synthetic/repo/commits/main' ? { sha: HEAD } : path.endsWith(`${SHA}...${OTHER}`) ? { status: 'ahead' } : { status: 'diverged' }],
      [async () => buildAnswer(OTHER), path => { if (path.endsWith('/commits/main')) throw new Error('down'); return { status: 'ahead' } }]]) {
      assert.equal(await main(['superseded', 'signed-out'], env, { gh: ghFor, get }), 1)
    }
    assert.equal(files.readOutput(), `superseded=${OTHER}\n`, 'nothing more was written')
    assert.equal(await main(['superseded', 'Bad Label'], env, { gh, get: async () => buildAnswer(OTHER) }), 1)
  } finally { files.done() }
})

const jobsWith = conclusion => ({ jobs: [{ name: 'target', steps: [] }, { name: 'deploy', steps: [{ name: 'Publish only main\'s newest commit', conclusion: 'success' }, { name: PUBLISH_STEP, conclusion }] }] })

test('observe-target: the live build, only after a run that published, and only when it is main\'s head or an older main commit', async () => {
  const ghFor = ({ jobs = jobsWith('success'), head = OTHER, status = 'ahead' } = {}) => async path => {
    if (path === 'repos/r/actions/runs/42/jobs?per_page=100') { if (!jobs) throw new Error('404'); return jobs }
    if (path === 'repos/r/commits/main') return { sha: head }
    if (path.startsWith('repos/r/compare/')) return { status }
    throw new Error('404')
  }
  assert.deepEqual(await observeTarget({ repository: 'r', gh: ghFor(), live: OTHER, runId: '42' }), { sha: OTHER, code: 'LIVE_IS_MAIN_HEAD' })
  assert.deepEqual(await observeTarget({ repository: 'r', gh: ghFor({ head: HEAD }), live: OTHER, runId: '' }), { sha: OTHER, code: 'LIVE_IS_AN_OLDER_MAIN_COMMIT' })
  for (const conclusion of ['skipped', 'failure', null]) {
    assert.deepEqual(await observeTarget({ repository: 'r', gh: ghFor({ jobs: jobsWith(conclusion) }), live: OTHER, runId: '42' }), { sha: null, code: 'NOTHING_PUBLISHED' }, String(conclusion))
  }
  assert.equal((await observeTarget({ repository: 'r', gh: ghFor({ jobs: { jobs: [{ name: 'observe', steps: [{ name: PUBLISH_STEP, conclusion: 'success' }] }] } }), live: OTHER, runId: '42' })).code, 'NOTHING_PUBLISHED')
  assert.equal((await observeTarget({ repository: 'r', gh: ghFor({ jobs: null }), live: OTHER, runId: '42' })).code, 'RUN_UNREADABLE')
  assert.equal((await observeTarget({ repository: 'r', gh: ghFor(), live: OTHER, runId: '42; rm -rf /' })).code, 'RUN_ID_INVALID')
  for (const status of ['diverged', 'behind']) assert.deepEqual(await observeTarget({ repository: 'r', gh: ghFor({ head: HEAD, status }), live: OTHER }), { sha: null, code: 'LIVE_NOT_ON_MAIN' })
  assert.equal((await observeTarget({ repository: 'r', gh: ghFor(), live: null, runId: '42' })).code, 'BUILD_UNREADABLE')
  // The step it looks for is deploy-x61.yml's publishing step, in its deploy job.
  const workflow = readFileSync(new URL('../../.github/workflows/deploy-x61.yml', import.meta.url), 'utf8')
  assert.ok(workflow.split('\n  deploy:\n')[1].includes(`      - name: ${PUBLISH_STEP}\n`))
})

test('observe-target CLI: sha output only for an observable release; nothing published is a clean notice; off main fails', async () => {
  const files = stepFiles()
  try {
    const env = { GITHUB_REPOSITORY: 'r', GITHUB_OUTPUT: files.output, GITHUB_STEP_SUMMARY: files.summary, OBSERVE_RUN_ID: '42' }
    const gh = jobs => path => path.endsWith('/jobs?per_page=100') ? jobs : path.endsWith('/commits/main') ? { sha: OTHER } : { status: 'diverged' }
    assert.equal(await main(['observe-target'], env, { gh: gh(jobsWith('skipped')), get: async () => buildAnswer(OTHER) }), 0)
    assert.equal(files.readOutput(), '')
    assert.match(files.readSummary(), /deploy-x61 run 42 published nothing/)
    assert.equal(await main(['observe-target'], env, { gh: gh(jobsWith('success')), get: async () => buildAnswer(OTHER) }), 0)
    assert.equal(files.readOutput(), `sha=${OTHER}\n`)
    assert.equal(await main(['observe-target'], env, { gh: gh(jobsWith('success')), get: async () => buildAnswer(SHA) }), 1)
    assert.equal(files.readOutput(), `sha=${OTHER}\n`, 'a live build off main names nothing to observe')
  } finally { files.done() }
})

const NOW = Date.parse('2026-11-12T12:00:00Z')
const minutesAgo = minutes => new Date(NOW - minutes * 60_000).toISOString()
const ACTIVITY_PATH = 'repos/r/activity?ref=refs%2Fheads%2Fmain&per_page=100'
/**
 * A synthetic GitHub, reads only: main's head; the compare live...head, whose commits carry their parents; each
 * first-parent commit's own compare parent...commit (its whole change, `commits[sha]`; a function there throws, as a 502
 * would); main's push log. Anything left undefined answers 404. Every path asked is recorded.
 */
function fakeGitHub({ head = HEAD, live = SHA, compare = null, commits = {}, activity } = {}) {
  const asked = []
  const parentOf = new Map((compare?.commits ?? []).map(item => [item.sha, item.parents?.[0]?.sha]))
  const own = (base, tip) => {
    if (!Object.hasOwn(commits, tip) || parentOf.get(tip) !== base) return null
    if (typeof commits[tip] === 'function') commits[tip]()
    return { status: 'ahead', ...(commits[tip] ?? {}) }
  }
  const gh = async path => {
    asked.push(path)
    if (path === 'repos/r/commits/main') return { sha: head }
    // When main's head is the live build's own child, this one compare is also the head's whole change.
    if (path === `repos/r/compare/${live}...${head}`) { if (!compare) throw new Error('404'); return { ...compare, ...(own(live, head) ?? {}) } }
    if (path.startsWith('repos/r/compare/')) { const found = own(...path.slice('repos/r/compare/'.length).split('...')); if (found) return found; throw new Error('404') }
    if (path === ACTIVITY_PATH && activity !== undefined) return activity
    throw new Error('404')
  }
  return { gh, asked }
}
const site = ({ live = HEAD, signin = true } = {}) => async path => path === '/api/build' ? buildAnswer(live) : { status: signin ? 401 : 500, contentType: 'text/html', body: signin ? SIGNIN : 'error' }
const watch = (github, read, extra = {}) => watchVerdict({ repository: 'r', gh: github.gh, read, now: () => NOW, sleep: async () => {}, ...extra })
/** The compare live...head: each item [sha, committed minutes ago, extra parents]; its first parent is the item before it (the first one's is the live build). */
const listed = (...items) => ({ status: 'ahead', total_commits: items.length, commits: items.map(([sha, minutes, extra = []], index) => ({ sha, parents: [{ sha: index ? items[index - 1][0] : SHA }, ...extra.map(parent => ({ sha: parent }))], commit: { committer: { date: minutesAgo(minutes) } } })) })
const touched = (...filenames) => ({ files: filenames.map(filename => ({ filename, status: 'modified' })) })
const fails502 = () => { throw Object.assign(new Error('HTTP 502'), { status: 502 }) }
const VERDICTS = ['LIVE_IS_NEWEST_RELEASE', 'LIVE_BEHIND', 'UNKNOWN']
/** A sequence of `count` distinct commit shas. */
const shas = count => Array.from({ length: count }, (_, index) => (index + 1).toString(16).padStart(40, '0'))

test('the watcher holds no authority: the guard exports nothing that dispatches, re-runs or cancels, and its one process call is a read', () => {
  for (const name of Object.keys(guard)) assert.doesNotMatch(name, /dispatch|heal|rerun|re_run|cancel|trigger/i, name)
  for (const name of ['healReason', 'HEAL_INTERVAL_MS', 'HEAL_GRACE_MS', 'HEAL_PUBLISH_PROBES', 'DEPLOY_CYCLE_MS', 'firstRelease']) assert.equal(Object.hasOwn(guard, name), false, name)
  const source = readFileSync(new URL('./deploy-guard.mjs', import.meta.url), 'utf8')
  // The only child process is `gh api <path>` (a GET: no -f, -F, --field, --input, -X or --method).
  assert.deepEqual([...source.matchAll(/execFileSync\(([^)]*?)\)/g)].map(match => match[1].split(',').slice(0, 3).join(',')), ["'gh', ['api', path]"])
  assert.doesNotMatch(source, /'workflow'|'run'|\/dispatches|\/rerun|\/cancel|--method|'-X'|'-f'|'-F'|--field|--input|actions\/workflows\/|rollback-x61\.yml\/runs/)
  // main() takes no dispatcher.
  assert.doesNotMatch(source.slice(source.indexOf('export async function main(')).split('\n')[0], /dispatch/)
})

test('watch: LIVE_IS_NEWEST_RELEASE when /api/build is main\'s head, or every first-parent commit back to it is confirmed docs-only', async () => {
  const same = await watch(fakeGitHub(), site())
  assert.deepEqual([same.verdict, same.live, same.head, same.signin], ['LIVE_IS_NEWEST_RELEASE', HEAD, HEAD, true])
  const docs = fakeGitHub({ compare: listed([OTHER, 300], [HEAD, 200]), commits: { [OTHER]: touched('docs/a.md'), [HEAD]: touched('README.md', 'docs/x/y.md') } })
  const verdict = await watch(docs, site({ live: SHA }))
  assert.deepEqual([verdict.verdict, verdict.live, verdict.head], ['LIVE_IS_NEWEST_RELEASE', SHA, HEAD])
  assert.match(verdict.detail, /only confirmed docs-only commits \(2\)/)
  // A rename inside the docs is docs-only.
  const renamed = fakeGitHub({ compare: listed([HEAD, 200]), commits: { [HEAD]: { files: [{ filename: 'docs/b.md', previous_filename: 'docs/a.md', status: 'renamed' }] } } })
  assert.equal((await watch(renamed, site({ live: SHA }))).verdict, 'LIVE_IS_NEWEST_RELEASE')
})

test('watch: a docs-only MERGE is docs-only, judged by its whole first-parent change; side-branch commits are never read one by one', async () => {
  const merge = listed([SIDE, 400], [OTHER, 300], [HEAD, 200, [SIDE]])
  merge.commits[0].parents = [{ sha: SHA }]
  merge.commits[1].parents = [{ sha: SHA }]
  merge.commits[2].parents = [{ sha: OTHER }, { sha: SIDE }]
  const docs = fakeGitHub({ compare: merge, commits: { [SIDE]: touched('docs/side.md'), [OTHER]: touched('docs/a.md'), [HEAD]: touched('docs/side.md') } })
  assert.equal((await watch(docs, site({ live: SHA }))).verdict, 'LIVE_IS_NEWEST_RELEASE')
  assert.equal(docs.asked.some(path => path.endsWith(`...${SIDE}`)), false)
  assert.ok(docs.asked.includes(`repos/r/compare/${OTHER}...${HEAD}`), 'the merge is read against its first parent')
  const code = fakeGitHub({ compare: merge, commits: { [OTHER]: touched('docs/a.md'), [HEAD]: touched('docs/side.md', 'apps/web/src/main.tsx') } })
  const behind = await watch(code, site({ live: SHA }))
  assert.deepEqual([behind.verdict, behind.release], ['LIVE_BEHIND', HEAD])
})

test('watch: LIVE_BEHIND names the live commit, main\'s NEWEST release (read newest first) and how long it has been on main', async () => {
  const [R1, R2, D] = shas(3)
  const github = fakeGitHub({ head: D, compare: listed([R1, 400], [R2, 300], [D, 100]), commits: { [R1]: touched('apps/web/src/a.ts'), [R2]: touched('deploy/cloudflare/src/worker.mjs'), [D]: touched('docs/note.md') },
    activity: [{ before: R2, after: D, timestamp: minutesAgo(90) }, { before: R1, after: R2, timestamp: minutesAgo(250) }, { before: SHA, after: R1, timestamp: minutesAgo(390) }] })
  const verdict = await watch(github, site({ live: SHA }))
  assert.deepEqual([verdict.verdict, verdict.live, verdict.head, verdict.release, verdict.since, verdict.clock, verdict.behindMs],
    ['LIVE_BEHIND', SHA, D, R2, minutesAgo(250), 'push', 250 * 60_000])
  assert.match(verdict.detail, /changes deploy\/cloudflare\/src\/worker\.mjs/)
  // Newest first: the walk stops at R2; the older release R1 is never read.
  assert.equal(github.asked.some(path => path.endsWith(`...${R1}`)), false)
  // No readable push for it (log unreadable, a 502, no push containing it, a bad timestamp): the wait is UNKNOWN, never the
  // committer date (a lane commit committed hours before it reached main would go red at once).
  for (const activity of [undefined, fails502, [{ before: SHA, after: '1'.repeat(40), timestamp: minutesAgo(1) }], [{ before: R1, after: R2, timestamp: 'not a date' }]]) {
    const github = fakeGitHub({ head: D, compare: listed([R1, 400], [R2, 300], [D, 100]), commits: { [R2]: touched('apps/web/src/x.ts'), [D]: touched('docs/a.md') }, activity })
    if (activity === fails502) { const inner = github.gh; github.gh = async path => { if (path === ACTIVITY_PATH) fails502(); return inner(path) } }
    const fallback = await watch(github, site({ live: SHA }))
    assert.deepEqual([fallback.verdict, fallback.release, fallback.since, fallback.clock, fallback.behindMs], ['LIVE_BEHIND', R2, null, 'unknown', null], String(activity))
    assert.match(fallback.failed, /main's push log .* could not be read or names no push containing/)
    const report = watchReport(fallback)
    assert.equal(report.red, false, String(activity))
    assert.ok(report.annotations.some(line => line.startsWith('::warning title=Live is behind main, wait unknown::')))
  }
  // The first push whose head CONTAINS the release starts the clock, even when a later push came on top of it.
  const pushed = await watch(fakeGitHub({ compare: listed([OTHER, 600], [HEAD, 590]), commits: { [HEAD]: touched('apps/web/src/x.ts') }, activity: [{ before: OTHER, after: HEAD, timestamp: minutesAgo(10) }] }), site({ live: SHA }))
  assert.deepEqual([pushed.since, pushed.clock], [minutesAgo(10), 'push'])
})

test('watch: the wait is the release\'s CURRENT uninterrupted stay on main; taken off and brought back, it counts from its return', async () => {
  const [D, ELSEWHERE] = shas(2)
  // The reviewer's sequence: R (HEAD) reached main yesterday; main was reset to L (the live build, SHA); main fast-forwarded
  // back to R one minute ago. The earliest push holding R is 1,440 minutes old; its current stay is one minute.
  const back = [{ before: SHA, after: HEAD, timestamp: minutesAgo(1) }, { before: HEAD, after: SHA, timestamp: minutesAgo(600) }, { before: SHA, after: HEAD, timestamp: minutesAgo(1440) }]
  const github = activity => fakeGitHub({ compare: listed([HEAD, 2000]), commits: { [HEAD]: touched('apps/web/src/x.ts') }, activity })
  const returned = await watch(github(back), site({ live: SHA }))
  assert.deepEqual([returned.verdict, returned.release, returned.since, returned.clock, returned.behindMs], ['LIVE_BEHIND', HEAD, minutesAgo(1), 'push', 60_000])
  assert.equal(watchReport(returned).red, false)
  // The same pushes in any order the API lists them.
  assert.equal((await watch(github([...back].reverse()), site({ live: SHA }))).since, minutesAgo(1))
  // The ordinary first time is as before: the push that brought it, even with a later push on top of it, red past the
  // allowance.
  const once = fakeGitHub({ head: D, compare: listed([HEAD, 2000], [D, 10]), commits: { [HEAD]: touched('apps/web/src/x.ts'), [D]: touched('docs/a.md') },
    activity: [{ before: HEAD, after: D, timestamp: minutesAgo(10) }, { before: SHA, after: HEAD, timestamp: minutesAgo(300) }, { before: OTHER, after: SHA, timestamp: minutesAgo(900) }] })
  const first = await watch(once, site({ live: SHA }))
  assert.deepEqual([first.release, first.since, first.behindMs], [HEAD, minutesAgo(300), 300 * 60_000])
  assert.equal(watchReport(first).red, true)
  // Reset to a commit the compare does not list, then back: one compare release...that commit decides it.
  const elsewhere = [{ before: ELSEWHERE, after: HEAD, timestamp: minutesAgo(5) }, { before: HEAD, after: ELSEWHERE, timestamp: minutesAgo(700) }, { before: SHA, after: HEAD, timestamp: minutesAgo(1440) }]
  const answering = status => { const inner = github(elsewhere); return { asked: inner.asked, gh: async path => { if (path !== `repos/r/compare/${HEAD}...${ELSEWHERE}`) return inner.gh(path); inner.asked.push(path); return status === 'fails' ? fails502() : { status } } } }
  const decided = answering('behind')
  assert.deepEqual([(await watch(decided, site({ live: SHA }))).since], [minutesAgo(5)])
  assert.ok(decided.asked.includes(`repos/r/compare/${HEAD}...${ELSEWHERE}`))
  // When its stay cannot be established, the wait is unknown and never red: that compare unreadable or unrecognised; a
  // logged push that left main without it (the log disagrees with main's head); a push with no readable before; the log
  // ending before the push that brought it.
  const unknownWaits = [
    ['compare unreadable', answering('fails')],
    ['compare unrecognised', answering('strange')],
    ['log disagrees with the head', github([{ before: HEAD, after: SHA, timestamp: minutesAgo(1) }, { before: SHA, after: HEAD, timestamp: minutesAgo(1440) }])],
    ['no readable before', github([{ after: HEAD, timestamp: minutesAgo(1) }])],
    ['log ends before it arrived', github([{ before: HEAD, after: HEAD, timestamp: minutesAgo(1440) }])],
    ['empty log', github([])],
  ]
  for (const [name, source] of unknownWaits) {
    const verdict = await watch(source, site({ live: SHA }))
    assert.deepEqual([verdict.verdict, verdict.since, verdict.clock, verdict.behindMs], ['LIVE_BEHIND', null, 'unknown', null], name)
    assert.match(verdict.failed, /names no push containing e{40} that begins its current uninterrupted stay on main/, name)
    assert.equal(watchReport(verdict).red, false, name)
  }
  // The compares it spends placing the release in the log are capped.
  const many = shas(12).map((sha, index) => ({ before: sha, after: HEAD, timestamp: minutesAgo(index + 1) }))
  const capped = fakeGitHub({ compare: listed([HEAD, 2000]), commits: { [HEAD]: touched('apps/web/src/x.ts') }, activity: many })
  const counting = { asked: capped.asked, gh: async path => { if (!path.startsWith(`repos/r/compare/${HEAD}...`)) return capped.gh(path); capped.asked.push(path); return { status: 'ahead' } } }
  assert.equal((await watch(counting, site({ live: SHA }))).behindMs, null)
  assert.equal(capped.asked.filter(path => path.startsWith(`repos/r/compare/${HEAD}...`)).length, WATCH_PRESENCE_READS)
})

test('watch: confirmed release, docs-only and unknown are three distinct results; what cannot be confirmed is UNKNOWN, never a release', async () => {
  const cases = [
    [touched('apps/web/src/main.tsx'), 'LIVE_BEHIND'],
    [touched('docs/a.md'), 'LIVE_IS_NEWEST_RELEASE'],
    [{ files: [{ filename: 'docs/a.md', previous_filename: 'deploy/cloudflare/src/worker.mjs', status: 'renamed' }] }, 'LIVE_BEHIND'],
    [{ files: Array.from({ length: 300 }, (_, index) => ({ filename: index === 299 ? 'apps/web/src/x.ts' : `docs/${index}.md`, status: 'modified' })) }, 'LIVE_BEHIND'],
    [fails502, 'UNKNOWN'],
    [undefined, 'UNKNOWN'],
    [{ files: [] }, 'UNKNOWN'],
    [{}, 'UNKNOWN'],
    [{ files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md`, status: 'modified' })) }, 'UNKNOWN'],
    [{ files: [{ filename: 'docs/a.md', status: 'renamed' }] }, 'UNKNOWN'],
    [{ files: [{ filename: 'docs/a.md', status: 'modified' }, { status: 'modified' }] }, 'UNKNOWN'],
  ]
  for (const [change, expected] of cases) {
    const github = fakeGitHub({ compare: listed([HEAD, 30]), commits: change === undefined ? {} : { [HEAD]: change } })
    const verdict = await watch(github, site({ live: SHA }))
    assert.equal(verdict.verdict, expected, JSON.stringify(change) ?? String(change))
    assert.ok(VERDICTS.includes(verdict.verdict))
    if (expected === 'UNKNOWN') {
      assert.match(verdict.failed, new RegExp(HEAD))
      assert.equal(verdict.release, undefined)
    }
  }
})

test('watch: the reviewer\'s reproduced cases are UNKNOWN: a failed file-list read among docs-only commits, and 35 docs-only commits (review loop4 MUST 3)', async () => {
  // Two actual docs-only commits; one file-list read fails with 502 (either one).
  for (const failing of [OTHER, HEAD]) {
    const commits = { [OTHER]: touched('docs/a.md'), [HEAD]: touched('docs/b.md'), [failing]: fails502 }
    const verdict = await watch(fakeGitHub({ compare: listed([OTHER, 300], [HEAD, 200]), commits }), site({ live: SHA }))
    assert.deepEqual([verdict.verdict, verdict.release], ['UNKNOWN', undefined], failing)
    assert.match(verdict.failed, new RegExp(`the file list of commit ${failing} .* could not be read`))
  }
  // 35 docs-only commits: the scan stops at WATCH_COMMIT_LIMIT, bounded, and says so.
  const many = shas(35).map((sha, index) => [sha, 500 - index])
  const tip = many.at(-1)[0]
  const docsOnly = Object.fromEntries(many.map(([sha]) => [sha, touched('docs/a.md')]))
  const bounded = fakeGitHub({ head: tip, compare: listed(...many), commits: docsOnly })
  const verdict = await watch(bounded, site({ live: SHA }))
  assert.equal(verdict.verdict, 'UNKNOWN')
  assert.match(verdict.failed, new RegExp(`the scan stopped after ${WATCH_COMMIT_LIMIT} first-parent commits, all docs-only`))
  assert.ok(bounded.asked.length <= WATCH_COMMIT_LIMIT + 3, `${bounded.asked.length} reads`)
  // A release past the limit is never read nor taken for one; a release within the newest 30 is found.
  const old = fakeGitHub({ head: tip, compare: listed(...many), commits: { ...docsOnly, [many[2][0]]: touched('apps/web/src/main.tsx') } })
  assert.equal((await watch(old, site({ live: SHA }))).verdict, 'UNKNOWN')
  assert.equal(old.asked.some(path => path.endsWith(`...${many[2][0]}`)), false)
  const recent = fakeGitHub({ head: tip, compare: listed(...many), commits: { ...docsOnly, [many[20][0]]: touched('apps/web/src/main.tsx') } })
  assert.deepEqual([(await watch(recent, site({ live: SHA }))).verdict, (await watch(recent, site({ live: SHA }))).release], ['LIVE_BEHIND', many[20][0]])
})

test('watch: what it cannot read or follow is UNKNOWN and names the read, never LIVE_BEHIND or LIVE_IS_NEWEST_RELEASE', async () => {
  const unreadableBuild = await watch(fakeGitHub(), async path => path === '/' ? { status: 401, contentType: 'text/html', body: SIGNIN } : { status: 500, contentType: 'text/plain', body: '' })
  assert.deepEqual([unreadableBuild.verdict, unreadableBuild.signin], ['UNKNOWN', true])
  assert.match(unreadableBuild.failed, /GET \/api\/build named no 40-hex commit in 3 attempts/)
  const noHead = await watch(fakeGitHub({ head: 'nope' }), site())
  assert.deepEqual([noHead.verdict, noHead.head], ['UNKNOWN', null])
  assert.match(noHead.failed, /main's head/)
  const noCompare = await watch(fakeGitHub({ compare: null }), site({ live: SHA }))
  assert.match(noCompare.failed, new RegExp(`compare ${SHA}\\.\\.\\.${HEAD}\\) could not be read`))
  // A compare GitHub cut off (head not listed, status ahead): the chain never reaches the live build, so nothing is
  // concluded about the newest release, and the live build IS on main, so nothing is red.
  const cutOff = { ...listed([OTHER, 300]), total_commits: 400 }
  cutOff.commits.forEach(item => { item.parents = [{ sha: OTHER }] })
  const truncated = await watch(fakeGitHub({ compare: cutOff, commits: { [HEAD]: touched('docs/a.md') } }), site({ live: SHA }))
  assert.deepEqual([truncated.verdict, truncated.liveOnMain], ['UNKNOWN', true])
  assert.match(truncated.failed, /does not reach the live build/)
  assert.equal(watchReport(truncated).red, false)
  // A compare that WAS read and says the live build is not on main (behind: an unmerged descendant of main's head was
  // published, or main was reset below it; diverged with only docs on main's side) is a fact, not an unknown: red at once,
  // as before.
  for (const compare of [{ status: 'behind', total_commits: 0, commits: [] }, { ...listed([HEAD, 30]), status: 'diverged' }]) {
    compare.commits.forEach(item => { item.parents = [{ sha: OTHER }] })
    const verdict = await watch(fakeGitHub({ compare, commits: { [HEAD]: touched('docs/a.md') } }), site({ live: SHA }))
    assert.deepEqual([verdict.verdict, verdict.liveOnMain, verdict.compareStatus], ['UNKNOWN', false, compare.status], compare.status)
    const report = watchReport(verdict)
    assert.equal(report.red, true, compare.status)
    assert.ok(report.lines.some(line => line.includes(`The live build ${SHA} is not a commit on main`) && line.includes(`status ${compare.status}`) && line.includes(BY_HAND)), compare.status)
    assert.ok(report.annotations.some(line => line.startsWith('::error title=Live build not on main::')))
  }
  // Diverged with a confirmed release on main's side: that release is not live (LIVE_BEHIND), and the live build is not on
  // main, which is red at once, inside the allowance.
  const diverged = { ...listed([HEAD, 30]), status: 'diverged' }
  diverged.commits[0].parents = [{ sha: OTHER }]
  const both = await watch(fakeGitHub({ compare: diverged, commits: { [HEAD]: touched('apps/web/src/x.ts') }, activity: [{ before: SHA, after: HEAD, timestamp: minutesAgo(30) }] }), site({ live: SHA }))
  assert.deepEqual([both.verdict, both.liveOnMain, both.behindMs], ['LIVE_BEHIND', false, 30 * 60_000])
  assert.equal(watchReport(both).red, true)
  // An unrecognised compare status is not read as "not on main".
  const odd = await watch(fakeGitHub({ compare: { ...listed([OTHER, 40], [HEAD, 30]), status: 'strange' }, commits: { [OTHER]: touched('docs/a.md'), [HEAD]: touched('docs/b.md') } }), site({ live: SHA }))
  assert.deepEqual([odd.compareStatus, odd.liveOnMain, watchReport(odd).red], ['strange', null, false])
  // A slow GitHub: once the read budget is spent, the rest is UNKNOWN and says so.
  let clock = NOW
  const slow = fakeGitHub({ compare: listed([OTHER, 300], [HEAD, 200]), commits: { [OTHER]: touched('docs/a.md'), [HEAD]: touched('docs/b.md') } })
  const ticking = { gh: async path => { clock += 61_000; return slow.gh(path) } }
  const spent = await watch(ticking, site({ live: SHA }), { now: () => clock, budgetMs: 180_000 })
  assert.equal(spent.verdict, 'UNKNOWN')
  assert.match(spent.failed, /budget for GitHub reads ran out/)
  // A blip on the site is retried before it counts.
  let calls = 0
  const flaky = async path => { calls += 1; return calls <= 2 ? { status: 503, contentType: 'text/html', body: '' } : site()(path) }
  assert.equal((await watch(fakeGitHub(), flaky)).verdict, 'LIVE_IS_NEWEST_RELEASE')
})

test('watch: the sign-in page is reported beside every verdict, and the watcher reads nothing about workflow runs', async () => {
  const github = fakeGitHub({ compare: listed([HEAD, 30]), commits: { [HEAD]: touched('apps/web/src/x.ts') } })
  const broken = await watch(github, site({ live: SHA, signin: false }))
  assert.deepEqual([broken.verdict, broken.signin], ['LIVE_BEHIND', false])
  assert.equal((await watch(fakeGitHub(), site({ signin: false }))).signin, false)
  for (const path of github.asked) assert.match(path, /^repos\/r\/(?:commits\/main|compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}|activity\?ref=refs%2Fheads%2Fmain&per_page=100)$/, path)
})

test('the LIVE_BEHIND allowance covers two back-to-back deploy runs at their job timeouts plus the watch interval', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/deploy-x61.yml', import.meta.url), 'utf8')
  const body = workflow.split('\njobs:\n')[1]
  const jobs = Object.fromEntries([...body.matchAll(/^ {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n|(?![\s\S]))/gm)].map(([, name, text]) => [name, {
    minutes: Number(text.match(/^ {4}timeout-minutes: (\d+)$/m)?.[1]),
    needs: (text.match(/^ {4}needs: (.+)$/m)?.[1] ?? '').replace(/^\[|\]$/g, '').split(',').map(value => value.trim()).filter(Boolean),
  }]))
  assert.deepEqual(Object.keys(jobs).sort(), ['build', 'bundle', 'deploy', 'preflight', 'scrub-dist', 'target'])
  const longest = name => jobs[name].minutes + Math.max(0, ...jobs[name].needs.map(longest))
  assert.equal(longest('deploy'), 105, 'the documented longest path: target 5 + build 45 + scrub-dist 15 + deploy 40')
  assert.ok(LIVE_BEHIND_ALLOWANCE_MS >= (2 * longest('deploy') + 15) * 60_000)
  assert.equal(LIVE_BEHIND_ALLOWANCE_MS, 240 * 60_000)
})

test('watch CLI: red only on LIVE_BEHIND past the allowance (saying a person runs the deploy by hand), a live build read as not on main, or a broken sign-in page; UNKNOWN is a green warning', async () => {
  const files = stepFiles()
  const logged = []
  const log = console.log
  console.log = line => { logged.push(String(line)) }
  try {
    const env = { GITHUB_REPOSITORY: 'r', GITHUB_STEP_SUMMARY: files.summary }
    const cli = (github, read) => main(['watch'], env, { gh: path => github.gh(path), get: (path, headers) => read(path, headers), now: () => NOW })
    let before = files.readSummary().length
    const fresh = () => { const text = files.readSummary().slice(before); before = files.readSummary().length; return text }
    assert.equal(await cli(fakeGitHub(), site()), 0)
    assert.match(fresh(), /^x61 watch LIVE_IS_NEWEST_RELEASE: \/api\/build e{40}, main e{40} \(the live build is main's head\)\.\nThe owner sign-in page renders signed out\.\n$/)
    const behind = minutes => fakeGitHub({ compare: listed([HEAD, minutes]), commits: { [HEAD]: touched('deploy/cloudflare/src/worker.mjs') }, activity: [{ before: SHA, after: HEAD, timestamp: minutesAgo(minutes) }] })
    // Within the allowance: a notice, green.
    assert.equal(await cli(behind(60), site({ live: SHA })), 0)
    const pending = fresh()
    assert.match(pending, new RegExp(`x61 watch LIVE_BEHIND: /api/build ${SHA} is not main's newest release ${HEAD}, which has been on main for 1 h 0 min`))
    assert.match(pending, /Within the 4 h 0 min allowance/)
    assert.doesNotMatch(pending, /by hand/)
    // Past it: red, and one plain sentence saying what a person does.
    assert.equal(await cli(behind(241), site({ live: SHA })), 1)
    const late = fresh()
    assert.match(late, /which has been on main for 4 h 1 min/)
    assert.ok(late.includes(`That is longer than the 4 h 0 min allowance. ${BY_HAND}`))
    assert.match(BY_HAND, /^To publish main, a person runs the "Deploy your-node to Cloudflare" workflow \(deploy-x61\.yml\) on main by hand/)
    assert.ok(logged.some(line => line.startsWith('::error title=Live is behind main::')))
    // UNKNOWN (a failed file-list read): a warning, green, nothing concluded.
    assert.equal(await cli(fakeGitHub({ compare: listed([OTHER, 999], [HEAD, 998]), commits: { [OTHER]: touched('docs/a.md'), [HEAD]: fails502 } }), site({ live: SHA })), 0)
    assert.match(fresh(), /^x61 watch UNKNOWN: the file list of commit e{40} .* could not be read\. .*Nothing about main's newest release is concluded from this run; the next one reads again\.\n/)
    assert.ok(logged.some(line => line.startsWith('::warning title=Watch inconclusive::')))
    // A live build that is not a commit on main (compare read as behind): red at once, saying what a person does.
    assert.equal(await cli(fakeGitHub({ compare: { status: 'behind', total_commits: 0, commits: [] } }), site({ live: SHA })), 1)
    assert.ok(fresh().includes(`The live build ${SHA} is not a commit on main (GitHub's compare with main's head ${HEAD} reads status behind): something that never reached main is published. ${BY_HAND}`))
    // A release committed long ago whose push cannot be read: not red, a warning naming the push log.
    assert.equal(await cli(fakeGitHub({ compare: listed([HEAD, 999]), commits: { [HEAD]: touched('apps/web/src/x.ts') } }), site({ live: SHA })), 0)
    assert.match(fresh(), /for a time that could not be read.*\nNot red: how long it has waited is unknown, because main's push log/)
    // GitHub entirely down: still green.
    assert.equal(await cli({ gh: async () => { throw new Error('503') } }, site({ live: SHA })), 0)
    assert.match(fresh(), /x61 watch UNKNOWN: main's head/)
    // The sign-in page not rendering is red whatever the verdict.
    assert.equal(await cli(fakeGitHub(), site({ signin: false })), 1)
    assert.match(fresh(), /The owner sign-in page did not render signed out/)
  } finally { console.log = log; files.done() }
})

test('watchReport: exactly one of the three verdicts per run, and the allowance edge', () => {
  const at = minutes => watchReport({ verdict: 'LIVE_BEHIND', live: SHA, head: HEAD, release: HEAD, since: minutesAgo(minutes), clock: 'push', behindMs: minutes * 60_000, detail: 'x', signin: true })
  assert.equal(at(240).red, false)
  assert.equal(at(241).red, true)
  assert.equal(watchReport({ verdict: 'LIVE_BEHIND', live: SHA, head: HEAD, release: HEAD, since: null, clock: 'unknown', behindMs: null, detail: 'x', signin: true }).red, false)
  assert.equal(watchReport({ verdict: 'UNKNOWN', live: null, head: null, failed: 'x', signin: true }).red, false)
  assert.equal(watchReport({ verdict: 'LIVE_IS_NEWEST_RELEASE', live: HEAD, head: HEAD, detail: 'x', signin: true }).red, false)
  // liveOnMain false (the compare was read) is red whatever the verdict; null (not read) never is.
  for (const verdict of [{ verdict: 'UNKNOWN', failed: 'x' }, { verdict: 'LIVE_BEHIND', release: HEAD, since: minutesAgo(1), clock: 'push', behindMs: 60_000, detail: 'x' }]) {
    assert.equal(watchReport({ live: SHA, head: HEAD, signin: true, liveOnMain: false, compareStatus: 'behind', ...verdict }).red, true, verdict.verdict)
    assert.equal(watchReport({ live: SHA, head: HEAD, signin: true, liveOnMain: null, ...verdict }).red, false, verdict.verdict)
  }
})
