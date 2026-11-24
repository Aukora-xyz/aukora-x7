#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * DEPLOY GUARD for .github/workflows/deploy-x61.yml, rollback-x61.yml and watch-x61.yml. Small pure helpers plus a CLI.
 * It never reads a secret, and no workflow runs it in a step that holds a Cloudflare credential
 * (deploy/ci/workflow-credentials.test.mjs). There is no ordering arithmetic here: a deploy run publishes main's head as
 * it is right before publishing, or nothing (the workflow re-reads main's head itself). Nothing here rolls anything back.
 *
 *   live-build                Prints the commit GET /api/build reports (signed out), or nothing. Always exits 0.
 *   verify-mirror             The repository-alone mirror integrity check before packaging (mirror-copy.mjs).
 *   configured-account        Prints account_id from deploy/cloudflare/wrangler.toml (the credentialed step compares it).
 *   previous-version          Reads `wrangler deployments status --json` on stdin; prints the one version at 100%.
 *   await-live                Within an absolute budget, GET /api/build must equal X61_EXPECT_BUILD_SHA and GET / must
 *                             render the owner sign-in page, three times in a row. Every request has an absolute deadline.
 *                             Exit 0 live; 1 the site answered wrongly; 3 the observer could not reach the edge at all.
 *   superseded <label>        After a failed observation of X61_EXPECT_BUILD_SHA: exit 0 (and write superseded=<sha>, a
 *                             notice and the summary line) only when /api/build now reports a commit that descends from it
 *                             AND is main's head or an ancestor of main's head, per GitHub's compare; otherwise exit 1 so
 *                             the failure stands.
 *   observe-target            For observe-x61.yml: after deploy-x61 run OBSERVE_RUN_ID (if given) published, writes
 *                             sha=<the live build> when that build is main's head or an older main commit; a run that
 *                             published nothing writes nothing; a live build that is not on main fails.
 *   watch                     The watcher. It ONLY REPORTS: it dispatches, re-runs and cancels nothing, and watch-x61.yml
 *                             grants it `contents: read` alone. It answers exactly one of
 *                             LIVE_IS_NEWEST_RELEASE (/api/build is main's head, or every first-parent commit after it is a
 *                             confirmed docs-only change); LIVE_BEHIND (a confirmed release on main is not live: the live
 *                             commit, main's newest release commit and how long it has been on main); UNKNOWN (which read
 *                             failed or ran out). It fails only on LIVE_BEHIND past LIVE_BEHIND_ALLOWANCE_MS, saying a
 *                             person runs deploy-x61 by hand; UNKNOWN is a warning, never red. Separately, as before, it
 *                             fails at once when GitHub's compare was read and shows the live build is NOT a commit on
 *                             main (status behind or diverged), and when the owner sign-in page does not render signed
 *                             out. "Was it deployed" is answered by /api/build, never by a job result.
 * The origin is a fixed constant. It lives under deploy/ (T2) because the deploy job runs it.
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { request as httpsRequest } from 'node:https'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { matchesDeployInertGlob } from './deploy-paths.mjs'
import { verifyMirrorTree } from './mirror-copy.mjs'

export const ORIGIN = 'https://node.example.invalid'
const SHA40 = /^[0-9a-f]{40}$/
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/**
 * Post-deploy check. timeoutMs is the absolute budget for the whole confirmation; every request also has an absolute
 * deadline (never an idle timeout), so a Worker that trickles bytes cannot stretch it.
 */
export const LIVE_WAIT = Object.freeze({ timeoutMs: 180_000, intervalMs: 5_000, needed: 3, requestTimeoutMs: 15_000, bodyBytes: 64 * 1024, controlTimeoutMs: 10_000 })
/** Hard ceiling for the await-live process, whatever hangs: budget + one request + the control probe + slack. */
export const AWAIT_LIVE_CEILING_MS = LIVE_WAIT.timeoutMs + LIVE_WAIT.requestTimeoutMs + LIVE_WAIT.controlTimeoutMs + 5_000
/**
 * How long main's newest release may be on main without being live before the watcher goes red: 4 hours. deploy-x61's
 * longest path of job timeouts is target 5 + build 45 + scrub-dist 15 + deploy 40 = 105 minutes. A release can wait for
 * one run ahead of it in the queue and then take its own run (2 x 105 = 210), and the watcher looks every 2 hours on a
 * schedule GitHub may delay; 240 covers that with room. A shorter allowance would turn an ordinary slow deploy red; this
 * one still reports a stranded release the same afternoon. (Several pushes in a burst queue several runs, so a release can
 * honestly take longer; that is reported too.) deploy-guard.test.mjs re-derives the 105 from the workflow file.
 */
export const LIVE_BEHIND_ALLOWANCE_MS = 240 * 60_000
/**
 * The most first-parent commits after the live build whose change the watcher reads one by one (newest first). Its reads
 * in all: main's head, the compare, at most this many commit changes, main's push log, and at most WATCH_PRESENCE_READS
 * compares to place the release in that log.
 */
export const WATCH_COMMIT_LIMIT = 30
/** The watcher's GitHub reads stop after this long; each `gh api` read is bounded at 20 s, so watch-x61's 10-minute job ends in time. */
export const WATCH_GITHUB_BUDGET_MS = 180_000
/** The most compare reads the watcher spends deciding whether a push in main's log held a release the listed commits cannot decide. */
export const WATCH_PRESENCE_READS = 10
/** deploy-x61.yml's publishing step; observe-x61 observes only after a run in which it succeeded. */
export const PUBLISH_STEP = 'Deploy the scrubbed Worker bundle to Cloudflare'
/** Did deploy-x61's deploy job publish in these jobs (its publishing step succeeded)? */
const publishedIn = jobs => jobs.some(job => job?.name === 'deploy' && Array.isArray(job.steps) && job.steps.some(step => step?.name === PUBLISH_STEP && step.conclusion === 'success'))

/**
 * @param {string} text stdout of `wrangler deployments status --json` (a deployment with versions[{version_id, percentage}]).
 * @returns {string} The single version id at 100% traffic: the version a human would roll back to.
 */
export function previousVersion(text) {
  let value = null
  const raw = String(text ?? '')
  try { value = JSON.parse(raw) } catch {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
    try { value = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null } catch { value = null }
  }
  const versions = value && typeof value === 'object' && Array.isArray(value.versions) ? value.versions : null
  if (!versions || versions.length !== 1) throw Object.assign(new Error('PREVIOUS_VERSION_UNRECORDABLE'), { code: 'PREVIOUS_VERSION_UNRECORDABLE' })
  const [only] = versions
  if (!only || only.percentage !== 100 || typeof only.version_id !== 'string' || !VERSION_ID.test(only.version_id)) {
    throw Object.assign(new Error('PREVIOUS_VERSION_UNRECORDABLE'), { code: 'PREVIOUS_VERSION_UNRECORDABLE' })
  }
  return only.version_id
}

/**
 * The stamped source revision from GET /api/build. Accepts a JSON object whose revision field (buildSha,
 * sourceRevision or revision) is a 40-hex SHA, or a text body that is exactly one. Anything else is null.
 * @returns {string|null}
 */
export function parseBuildSha(status, contentType, body) {
  if (status !== 200 || typeof body !== 'string') return null
  const type = String(contentType ?? '').toLowerCase()
  if (type.startsWith('application/json')) {
    let value
    try { value = JSON.parse(body) } catch { return null }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const found = ['buildSha', 'sourceRevision', 'revision'].filter(key => value[key] !== undefined).map(key => value[key])
    const shas = [...new Set(found.map(item => typeof item === 'string' ? item.toLowerCase() : item))]
    return shas.length === 1 && typeof shas[0] === 'string' && SHA40.test(shas[0]) ? shas[0] : null
  }
  if (type.startsWith('text/plain')) {
    const text = body.trim().toLowerCase()
    return SHA40.test(text) ? text : null
  }
  return null
}

/** The owner sign-in page as the Worker serves it signed out (worker.mjs ownerSignin: 401 HTML, title and passkey button). */
export function signinPageRenders(status, contentType, body) {
  return status === 401 && String(contentType ?? '').toLowerCase().startsWith('text/html') && typeof body === 'string'
    && body.includes('<title>Owner sign-in</title>') && body.includes('id="passkey-submit"')
}

/**
 * Is the live build a NEWER commit ON MAIN than `target`? It must descend from `target` AND be main's head or an ancestor
 * of it (review loop3 S5: a branch commit published from elsewhere descends from target but never reached main).
 * `compare(base, head)` is GitHub's compare of base...head and returns its `status` ('ahead' = head descends from base).
 * Anything unreadable is not a supersession.
 * @returns {Promise<string|null>} The newer live commit, or null.
 */
export async function supersededBy({ target, live, head, compare }) {
  if (!SHA40.test(String(target)) || !SHA40.test(String(live)) || !SHA40.test(String(head)) || live === target) return null
  try {
    if ((await compare(target, live))?.status !== 'ahead') return null
    return live === head || (await compare(live, head))?.status === 'ahead' ? live : null
  } catch { return null }
}

/**
 * What observe-x61 observes: the live build, when it is main's head or an older main commit, and (for a workflow_run of
 * deploy-x61) only when that run's deploy job published. `gh(path)` is GitHub REST for `repos/<repository>/...`.
 * @returns {Promise<{ sha: string|null, code: string }>}
 */
export async function observeTarget({ repository, gh, live, runId }) {
  if (runId !== undefined && runId !== '') {
    if (!/^[1-9][0-9]{0,19}$/.test(String(runId))) return { sha: null, code: 'RUN_ID_INVALID' }
    let jobs = null
    try { jobs = (await gh(`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`))?.jobs } catch { jobs = null }
    if (!Array.isArray(jobs)) return { sha: null, code: 'RUN_UNREADABLE' }
    if (!publishedIn(jobs)) return { sha: null, code: 'NOTHING_PUBLISHED' }
  }
  if (!SHA40.test(String(live))) return { sha: null, code: 'BUILD_UNREADABLE' }
  let head = null
  try { head = String((await gh(`repos/${repository}/commits/main`))?.sha ?? '').toLowerCase() } catch { head = null }
  if (!SHA40.test(String(head))) return { sha: null, code: 'MAIN_HEAD_UNREADABLE' }
  if (live === head) return { sha: live, code: 'LIVE_IS_MAIN_HEAD' }
  let status = null
  try { status = (await gh(`repos/${repository}/compare/${live}...${head}`))?.status } catch { status = null }
  return status === 'ahead' ? { sha: live, code: 'LIVE_IS_AN_OLDER_MAIN_COMMIT' } : { sha: null, code: 'LIVE_NOT_ON_MAIN' }
}

/**
 * The watcher's report. It holds no authority: nothing here dispatches, re-runs or cancels anything, and `gh(path)` is a
 * GitHub REST read of `repos/<repository>/...`; `read(path)` is a bounded signed-out GET of the site. Both are injected.
 * The verdict is exactly one of:
 *   LIVE_IS_NEWEST_RELEASE  /api/build is main's head, or every first-parent commit from main's head back to it is a
 *                           CONFIRMED docs-only change (so main's newest release is live).
 *   LIVE_BEHIND             a CONFIRMED release on main is not live: `live`, `release` (main's newest release commit),
 *                           `since` (the push that began its current uninterrupted stay on main, from main's push log;
 *                           reachedMainAt) and `behindMs`. When that cannot be established, `since` and `behindMs` are null, `clock` is
 *                           'unknown' and `failed` names that read: a committer date is never the clock (a lane commit
 *                           can reach main hours after it was committed).
 *   UNKNOWN                 `failed` names the read that failed or what ran out. Never "release", never "fine".
 * Reported beside the verdict, whatever it is: `signin` (the owner sign-in page renders signed out) and `liveOnMain`
 * (true: /api/build is main's head or GitHub's compare of it with main's head read status 'ahead'; false: the compare was
 * read and its status is 'behind' or 'diverged', so the live build is not a commit on main; null: not read, or any other
 * status). A false liveOnMain is a FACT that was read, not an unknown: watchReport makes it red at once.
 * @returns {Promise<{ verdict: 'LIVE_IS_NEWEST_RELEASE'|'LIVE_BEHIND'|'UNKNOWN', live: string|null, head: string|null, signin: boolean, liveOnMain: boolean|null, compareStatus?: string, release?: string, since?: string|null, clock?: string, behindMs?: number|null, failed?: string, detail?: string }>}
 */
export async function watchVerdict({ repository, gh: ask, read, now = Date.now, attempts = 3, budgetMs = WATCH_GITHUB_BUDGET_MS, sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  let live = null, signin = false
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const build = await read('/api/build', { accept: 'application/json' }).catch(() => null)
    live = build ? parseBuildSha(build.status, build.contentType, build.body) : null
    const page = await read('/', { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }).catch(() => null)
    signin = page ? signinPageRenders(page.status, page.contentType, page.body) : false
    if (live && signin) break
    if (attempt < attempts) await sleep(10_000)
  }
  // GitHub reads stop once the budget is spent (each read is itself bounded), so a slow API ends as UNKNOWN, not a timeout.
  const started = now()
  let spent = false
  const cache = new Map()
  const gh = path => {
    if (cache.has(path)) return cache.get(path)
    if (now() - started > budgetMs) { spent = true; return Promise.reject(new Error('WATCH_BUDGET_SPENT')) }
    // Each path is read once (main's head's own change may be the compare of the live build with it).
    cache.set(path, Promise.resolve().then(() => ask(path)))
    return cache.get(path)
  }
  let head = null, liveOnMain = null, compareStatus
  const facts = () => ({ live, head, signin, liveOnMain, ...(compareStatus === undefined ? {} : { compareStatus }) })
  const unknown = failed => ({ verdict: 'UNKNOWN', ...facts(), failed: spent ? `${failed} (the watcher's ${budgetMs / 1000} s budget for GitHub reads ran out)` : failed })
  if (!live) return unknown(`GET /api/build named no 40-hex commit in ${attempts} attempts`)
  try { head = String((await gh(`repos/${repository}/commits/main`))?.sha ?? '').toLowerCase() } catch { head = null }
  if (!SHA40.test(String(head))) { head = null; return unknown('main\'s head (GitHub commits/main) could not be read') }
  if (live === head) { liveOnMain = true; return { verdict: 'LIVE_IS_NEWEST_RELEASE', ...facts(), detail: 'the live build is main\'s head' } }
  let comparison = null
  try { comparison = await gh(`repos/${repository}/compare/${live}...${head}`) } catch { comparison = null }
  if (!comparison || !Array.isArray(comparison.commits)) return unknown(`the compare of the live build with main's head (compare ${live}...${head}) could not be read`)
  // The compare was read: 'ahead' means main's head descends from the live build; 'behind' or 'diverged' means the live
  // build is not a commit on main. That is reported beside the verdict and is red on its own.
  compareStatus = String(comparison.status ?? 'unknown')
  liveOnMain = comparison.status === 'ahead' ? true : comparison.status === 'behind' || comparison.status === 'diverged' ? false : null
  const found = await newestRelease({ repository, gh, live, head, comparison, limit: WATCH_COMMIT_LIMIT })
  if (found.kind === 'unknown') return unknown(found.failed)
  if (found.kind === 'docs-only') return { verdict: 'LIVE_IS_NEWEST_RELEASE', ...facts(), detail: `only confirmed docs-only commits (${found.read}) after the live build` }
  const since = await reachedMainAt({ repository, gh, release: found.commit.sha, live, commits: comparison.commits, total: comparison.total_commits })
  const behind = { verdict: 'LIVE_BEHIND', ...facts(), release: found.commit.sha, detail: found.detail }
  if (!since) return { ...behind, since: null, clock: 'unknown', behindMs: null, failed: `main's push log (activity of refs/heads/main) could not be read or names no push containing ${found.commit.sha} that begins its current uninterrupted stay on main${spent ? ` (the watcher's ${budgetMs / 1000} s budget for GitHub reads ran out)` : ''}` }
  return { ...behind, since, clock: 'push', behindMs: Math.max(0, now() - Date.parse(since)) }
}

/**
 * Classifies one first-parent commit by its WHOLE change against its first parent (GitHub's compare parent...commit, so a
 * merge counts by everything it brings in). A changed path outside DEPLOY_INERT_GLOBS (for a rename, either name) makes it
 * a confirmed release. Only a complete, readable list of inert paths makes it docs-only. Anything else (the list cannot be
 * read, is empty, may be cut off at GitHub's 300 files, or holds an entry with no usable path) is unknown.
 * @returns {Promise<{ kind: 'release', detail: string } | { kind: 'docs-only' } | { kind: 'unknown', failed: string }>}
 */
export async function classifyCommit({ repository, gh, item }) {
  const sha = String(item?.sha)
  const parent = Array.isArray(item?.parents) ? item.parents[0]?.sha : undefined
  if (!SHA40.test(String(parent))) return { kind: 'unknown', failed: `commit ${sha} has no readable first parent` }
  let files = null
  try { files = (await gh(`repos/${repository}/compare/${parent}...${sha}`))?.files } catch { files = null }
  if (!Array.isArray(files)) return { kind: 'unknown', failed: `the file list of commit ${sha} (compare ${parent}...${sha}) could not be read` }
  const usable = file => typeof file?.filename === 'string' && file.filename !== '' && (file.status !== 'renamed' || (typeof file.previous_filename === 'string' && file.previous_filename !== ''))
  const deployed = files.find(file => usable(file) && (!matchesDeployInertGlob(file.filename) || (file.status === 'renamed' && !matchesDeployInertGlob(file.previous_filename))))
  if (deployed) return { kind: 'release', detail: `commit ${sha} changes ${deployed.filename}` }
  if (files.length === 0) return { kind: 'unknown', failed: `commit ${sha} lists no changed file` }
  if (files.length >= 300) return { kind: 'unknown', failed: `commit ${sha} lists ${files.length} files, GitHub's most, so a deployed path may be unlisted` }
  if (!files.every(usable)) return { kind: 'unknown', failed: `commit ${sha} lists a changed file with no usable path` }
  return { kind: 'docs-only' }
}

/**
 * Main's newest release after the live build: the first-parent commits from main's head back towards the live build are
 * read one by one, NEWEST first, and the first confirmed release is the answer. Docs-only only when the walk reaches the
 * live build itself with every commit on the way confirmed docs-only. The walk stops as unknown at the first commit that
 * cannot be classified, when the chain leaves what the compare listed (GitHub cut the compare off, or the live build is not
 * on main's first-parent line), or after `limit` reads.
 * @returns {Promise<{ kind: 'release', commit: object, detail: string } | { kind: 'docs-only', read: number } | { kind: 'unknown', failed: string }>}
 */
export async function newestRelease({ repository, gh, live, head, comparison, limit = WATCH_COMMIT_LIMIT }) {
  const listed = new Map(comparison.commits.filter(item => SHA40.test(String(item?.sha))).map(item => [item.sha, item]))
  const seen = new Set()
  let sha = head, read = 0
  while (sha !== live) {
    const item = listed.get(sha)
    if (!item || seen.has(sha)) {
      const total = Number(comparison.total_commits)
      return { kind: 'unknown', failed: `main's first-parent line from its head does not reach the live build within the compare (commit ${String(sha)} not listed; ${comparison.commits.length} of ${Number.isFinite(total) ? total : 'unknown'} commits listed, status ${String(comparison.status ?? 'unknown')})` }
    }
    if (read >= limit) return { kind: 'unknown', failed: `the scan stopped after ${limit} first-parent commits, all docs-only, before reaching the live build` }
    seen.add(sha)
    read += 1
    const kind = await classifyCommit({ repository, gh, item })
    if (kind.kind === 'release') return { kind: 'release', commit: item, detail: kind.detail }
    if (kind.kind === 'unknown') return kind
    sha = item.parents[0].sha
  }
  return { kind: 'docs-only', read }
}

/**
 * Since when `release` has been on main WITHOUT A BREAK (a release that reached main yesterday,
 * was taken off by a reset and came back a minute ago has waited one minute, not a day). GitHub's activity log for main
 * is walked newest first. Every push in it must leave the release on main (`after` contains it); the clock starts at the
 * newest push whose `before` did NOT contain it. Containment is decided from the parents GitHub's compare of the live build
 * with main's head already listed (exact when that list is complete; the live build and the empty sha never contain it,
 * as the release is not an ancestor of the live build), otherwise by one compare `release...sha` read each (at most
 * WATCH_PRESENCE_READS of them). Null, so the caller reports the wait as unknown and never red, when: the log cannot be
 * read or is empty; a push in it has no readable timestamp, `before` or `after`; a containment cannot be decided; a
 * logged push left main without the release (the log disagrees with the head that was read); or the log ends before the
 * push that brought it (it has been there longer than the log reaches, by an amount that was not read).
 * @returns {Promise<string|null>} An ISO timestamp, or null.
 */
export async function reachedMainAt({ repository, gh, release, live, commits, total }) {
  if (!SHA40.test(String(release)) || !Array.isArray(commits)) return null
  let activity = null
  try { activity = await gh(`repos/${repository}/activity?ref=refs%2Fheads%2Fmain&per_page=100`) } catch { return null }
  if (!Array.isArray(activity) || activity.length === 0) return null
  const pushes = activity.map(push => ({ at: Date.parse(String(push?.timestamp)), before: String(push?.before).toLowerCase(), after: String(push?.after).toLowerCase() }))
  if (!pushes.every(push => Number.isFinite(push.at) && SHA40.test(push.before) && SHA40.test(push.after))) return null
  pushes.sort((a, b) => b.at - a.at)
  const parentsOf = new Map(commits.filter(item => SHA40.test(String(item?.sha))).map(item => [item.sha, Array.isArray(item.parents) ? item.parents.map(parent => parent?.sha) : []]))
  const complete = Number(total) === commits.length && parentsOf.size === commits.length
  const reachable = tip => {
    const seen = new Set(), queue = [tip]
    while (queue.length) {
      const sha = queue.pop()
      if (sha === release) return true
      if (seen.has(sha) || !parentsOf.has(sha)) continue
      seen.add(sha)
      queue.push(...parentsOf.get(sha))
    }
    return false
  }
  let reads = 0
  const holds = async sha => {
    if (sha === release) return true
    if (sha === live || /^0{40}$/.test(sha)) return false
    if (parentsOf.has(sha) && reachable(sha)) return true
    if (parentsOf.has(sha) && complete) return false
    if (reads >= WATCH_PRESENCE_READS) return null
    reads += 1
    let status = null
    try { status = (await gh(`repos/${repository}/compare/${release}...${sha}`))?.status } catch { return null }
    return status === 'ahead' || status === 'identical' ? true : status === 'behind' || status === 'diverged' ? false : null
  }
  for (const push of pushes) {
    if (await holds(push.after) !== true) return null
    const before = await holds(push.before)
    if (before === null) return null
    if (before === false) return new Date(push.at).toISOString()
  }
  return null
}

/**
 * Poll until the new build is live: `needed` consecutive reads where /api/build equals expectedSha AND the sign-in page
 * renders. The budget is absolute: `get(path, headers, ms)` must settle within `ms`, and no request is given more time
 * than is left. A rejection carrying `answered: true` means the site sent a status but not a timely body (the site's
 * fault); a plain rejection means no answer reached the observer. Transport, clock and sleep are injected for tests.
 * @returns {Promise<{ ok: boolean, code: string, attempts: number, answered: boolean, lastBuildSha: string|null, lastSigninRendered: boolean }>}
 */
export async function awaitLive({ expectedSha, get, now = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)), limits = LIVE_WAIT }) {
  if (typeof expectedSha !== 'string' || !SHA40.test(expectedSha)) return { ok: false, code: 'EXPECTED_SHA_INVALID', attempts: 0, answered: false, lastBuildSha: null, lastSigninRendered: false }
  const deadline = now() + limits.timeoutMs
  const left = () => deadline - now()
  let streak = 0, attempts = 0, answered = false, lastBuildSha = null, lastSigninRendered = false
  const read = async (path, headers) => {
    const ms = Math.min(limits.requestTimeoutMs, left())
    if (ms <= 0) return null
    try {
      const response = await get(path, headers, ms)
      answered = true
      return response
    } catch (error) {
      if (error?.answered === true) answered = true
      return null
    }
  }
  while (left() > 0) {
    attempts += 1
    const build = await read('/api/build', { accept: 'application/json' })
    lastBuildSha = build ? parseBuildSha(build.status, build.contentType, build.body) : null
    const signin = await read('/', { accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })
    lastSigninRendered = signin ? signinPageRenders(signin.status, signin.contentType, signin.body) : false
    streak = lastBuildSha === expectedSha && lastSigninRendered ? streak + 1 : 0
    if (streak >= limits.needed) return { ok: true, code: 'LIVE', attempts, answered, lastBuildSha, lastSigninRendered }
    if (left() <= limits.intervalMs) break
    await sleep(limits.intervalMs)
  }
  const code = !answered ? 'NO_ANSWER' : lastBuildSha !== expectedSha ? 'BUILD_NOT_LIVE' : 'SIGNIN_PAGE_NOT_RENDERED'
  return { ok: false, code, attempts, answered, lastBuildSha, lastSigninRendered }
}

/**
 * One GET with an ABSOLUTE deadline: the timer destroys the request after `deadlineMs` whatever the socket is doing, so
 * a response trickling one byte at a time ends on time. Rejections carry `answered: true` once a status line arrived.
 * `request` and `origin` are injectable for a local test server; the CLI always uses node:https and ORIGIN.
 */
export function boundedGet(path, headers, deadlineMs, { request = httpsRequest, origin = ORIGIN, bodyBytes = LIVE_WAIT.bodyBytes } = {}) {
  return new Promise((resolveGet, rejectGet) => {
    const target = new URL(path, origin)
    if (target.origin !== origin) { rejectGet(new Error('ORIGIN_REFUSED')); return }
    let answered = false, settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectGet(Object.assign(error, { answered })); else resolveGet(value)
    }
    const req = request(target, { method: 'GET', headers: { 'user-agent': 'x61-deploy-guard', 'cache-control': 'no-store', ...headers } }, response => {
      answered = true
      const chunks = []
      let bytes = 0
      response.on('data', chunk => {
        bytes += chunk.length
        if (bytes > bodyBytes) { response.destroy(); finish(new Error('BODY_TOO_LARGE')); return }
        chunks.push(chunk)
      })
      response.on('end', () => finish(null, { status: response.statusCode, contentType: response.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', error => finish(error))
      response.on('close', () => finish(new Error('CLOSED_EARLY')))
    })
    const timer = setTimeout(() => { req.destroy(); finish(new Error('DEADLINE')) }, Math.max(1, deadlineMs))
    req.on('error', error => finish(error))
    req.end()
  })
}

/** Cloudflare's own edge answer for this hostname (served by Cloudflare before any Worker runs). */
export async function edgeReachable(get = boundedGet, ms = LIVE_WAIT.controlTimeoutMs) {
  try {
    const answer = await get('/cdn-cgi/trace', { accept: 'text/plain' }, ms)
    return answer.status === 200 && /(?:^|\n)colo=/.test(answer.body)
  } catch { return false }
}

/** account_id from wrangler.toml text (exactly one 32-hex value). */
export function configuredAccount(toml) {
  const matches = [...String(toml).matchAll(/^account_id\s*=\s*"([0-9a-f]{32})"\s*$/gm)]
  return matches.length === 1 ? matches[0][1] : null
}

/** Hours and minutes, for a person. */
const duration = ms => `${Math.floor(ms / 3_600_000)} h ${Math.floor(ms / 60_000) % 60} min`
/** What a person does about a stranded release: the watcher itself never does it. */
export const BY_HAND = 'To publish main, a person runs the "Deploy your-node to Cloudflare" workflow (deploy-x61.yml) on main by hand; if the live build was rolled back on purpose, revert that release on main instead.'

/**
 * The job summary lines, the log annotations and whether the run is red. Red: LIVE_BEHIND past `allowanceMs`, a live build
 * that the compare READ as not on main (`liveOnMain === false`, whatever the verdict), or the owner sign-in page not
 * rendering. LIVE_BEHIND within the allowance is a notice; UNKNOWN is a warning; neither is red, so an
 * outage of GitHub's API pages nobody.
 * @returns {{ red: boolean, lines: string[], annotations: string[] }}
 */
export function watchReport(verdict, allowanceMs = LIVE_BEHIND_ALLOWANCE_MS) {
  const lines = [], annotations = []
  let red = false
  if (verdict.verdict === 'LIVE_IS_NEWEST_RELEASE') {
    lines.push(`x61 watch LIVE_IS_NEWEST_RELEASE: /api/build ${verdict.live}, main ${verdict.head} (${verdict.detail}).`)
  } else if (verdict.verdict === 'LIVE_BEHIND') {
    const known = Number.isFinite(verdict.behindMs)
    const how = known ? `for ${duration(verdict.behindMs)} (since ${verdict.since}, by its ${verdict.clock})` : 'for a time that could not be read'
    const line = `x61 watch LIVE_BEHIND: /api/build ${verdict.live} is not main's newest release ${verdict.release}, which has been on main ${how}; main's head is ${verdict.head} (${verdict.detail}).`
    lines.push(line)
    if (known && verdict.behindMs > allowanceMs) {
      red = true
      lines.push(`That is longer than the ${duration(allowanceMs)} allowance. ${BY_HAND}`)
      annotations.push(`::error title=Live is behind main::${line} ${BY_HAND}`)
    } else {
      if (known) {
        lines.push(`Within the ${duration(allowanceMs)} allowance: its deploy run may still be on its way.`)
        annotations.push(`::notice title=Live is behind main::${line}`)
      } else {
        lines.push(`Not red: how long it has waited is unknown, because ${verdict.failed ?? 'its push to main could not be read'}. The next run reads again.`)
        annotations.push(`::warning title=Live is behind main, wait unknown::${line}`)
      }
    }
  } else {
    const line = `x61 watch UNKNOWN: ${verdict.failed}. /api/build ${verdict.live ?? 'unreadable'}, main ${verdict.head ?? 'unreadable'}. Nothing about main's newest release is concluded from this run; the next one reads again.`
    lines.push(line)
    annotations.push(`::warning title=Watch inconclusive::${line}`)
  }
  if (verdict.liveOnMain === false) {
    // Read, not unknown: GitHub's compare of the live build with main's head answered behind or diverged.
    red = true
    const line = `The live build ${verdict.live} is not a commit on main (GitHub's compare with main's head ${verdict.head} reads status ${verdict.compareStatus}): something that never reached main is published.`
    lines.push(`${line} ${BY_HAND}`)
    annotations.push(`::error title=Live build not on main::${line} ${BY_HAND}`)
  }
  if (verdict.signin) lines.push('The owner sign-in page renders signed out.')
  else {
    red = true
    const line = 'The owner sign-in page did not render signed out (GET / is not the 401 sign-in page with its passkey button).'
    lines.push(line)
    annotations.push(`::error title=Sign-in page::${line}`)
  }
  return { red, lines, annotations }
}

const readStdin = () => { try { return readFileSync(0, 'utf8') } catch { return '' } }
const readText = file => { try { return readFileSync(file, 'utf8') } catch { return '' } }
const fail = (message) => { console.error(`::error title=Deploy guard::${message}`); return 1 }
const repoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** GitHub REST through the runner's `gh` with GH_TOKEN (the workflow's own token). */
const ghApi = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }))
const appendTo = (file, text) => { if (file) appendFileSync(file, text) }

export async function main(args = process.argv.slice(2), env = process.env, { gh = ghApi, get = boundedGet, now = Date.now } = {}) {
  const [command, first] = args
  if (command === 'live-build' && args.length === 1) {
    const answer = await get('/api/build', { accept: 'application/json' }, LIVE_WAIT.requestTimeoutMs).catch(() => null)
    const sha = answer ? parseBuildSha(answer.status, answer.contentType, answer.body) : null
    if (sha) console.log(sha)
    return 0
  }
  if (command === 'verify-mirror' && args.length === 1) {
    const root = repoRoot()
    const result = await verifyMirrorTree({
      read: path => { try { return new Uint8Array(readFileSync(join(root, path))) } catch { return null } },
      list: path => { try { return readdirSync(join(root, path)) } catch { return [] } },
    })
    console.log(JSON.stringify({ phase: 'verify-mirror', ok: result.ok, checked: result.checked, problems: result.problems, unreferencedLineageFiles: result.unreferenced.length, candidateOrgans: result.candidates }))
    if (!result.ok) return fail(`MIRROR_INTEGRITY: ${result.problems.slice(0, 5).join('; ')}`)
    return 0
  }
  if (command === 'configured-account' && args.length === 1) {
    const account = configuredAccount(readText(join(repoRoot(), 'deploy/cloudflare/wrangler.toml')))
    if (!account) return fail('ACCOUNT_UNCONFIGURED: deploy/cloudflare/wrangler.toml has no single account_id. Nothing was deployed.')
    console.log(account)
    return 0
  }
  if (command === 'previous-version' && args.length === 1) {
    try { console.log(previousVersion(readStdin())); return 0 } catch {
      return fail('PREVIOUS_VERSION_UNRECORDABLE: the live deployment is not one Worker version at 100%, so there is no version to name for a rollback. Nothing was deployed.')
    }
  }
  if (command === 'await-live' && args.length === 1) {
    const expectedSha = String(env.X61_EXPECT_BUILD_SHA ?? '').toLowerCase()
    // Whatever hangs, this process ends inside its step's budget.
    const ceiling = setTimeout(() => { console.log(JSON.stringify({ phase: 'await-live', expectedSha, ok: false, code: 'OBSERVER_CEILING' })); process.exit(3) }, AWAIT_LIVE_CEILING_MS)
    ceiling.unref()
    const result = await awaitLive({ expectedSha, get })
    let code = result.code
    if (code === 'NO_ANSWER') code = await edgeReachable(get) ? 'SITE_NOT_ANSWERING' : 'OBSERVER_UNREACHABLE'
    console.log(JSON.stringify({ phase: 'await-live', expectedSha, ...result, code }))
    return result.ok ? 0 : code === 'OBSERVER_UNREACHABLE' ? 3 : 1
  }
  if (command === 'superseded' && args.length === 2 && /^[a-z-]{1,40}$/.test(String(first))) {
    const target = String(env.X61_EXPECT_BUILD_SHA ?? '').toLowerCase()
    const answer = await get('/api/build', { accept: 'application/json' }, LIVE_WAIT.requestTimeoutMs).catch(() => null)
    const live = answer ? parseBuildSha(answer.status, answer.contentType, answer.body) : null
    let head = null
    try { head = String((await gh(`repos/${env.GITHUB_REPOSITORY}/commits/main`))?.sha ?? '').toLowerCase() } catch { head = null }
    const newer = await supersededBy({ target, live, head, compare: (base, tip) => gh(`repos/${env.GITHUB_REPOSITORY}/compare/${base}...${tip}`) })
    if (!newer) return 1
    const notice = `SUPERSEDED: the live build is now ${newer}, a newer commit on main, so this ${first} observation of ${target} counts neither way.`
    console.log(`::notice title=Observation superseded::${notice}`)
    appendTo(env.GITHUB_OUTPUT, `superseded=${newer}\n`)
    appendTo(env.GITHUB_STEP_SUMMARY, `${notice}\n`)
    return 0
  }
  if (command === 'observe-target' && args.length === 1) {
    const answer = await get('/api/build', { accept: 'application/json' }, LIVE_WAIT.requestTimeoutMs).catch(() => null)
    const live = answer ? parseBuildSha(answer.status, answer.contentType, answer.body) : null
    const runId = String(env.OBSERVE_RUN_ID ?? '')
    const result = await observeTarget({ repository: String(env.GITHUB_REPOSITORY ?? ''), gh, live, runId })
    console.log(JSON.stringify({ phase: 'observe-target', runId, live, ...result }))
    if (result.code === 'NOTHING_PUBLISHED') {
      const notice = `deploy-x61 run ${runId} published nothing (superseded, or no production credential), so there is nothing new to observe.`
      console.log(`::notice title=Nothing to observe::${notice}`)
      appendTo(env.GITHUB_STEP_SUMMARY, `${notice}\n`)
      return 0
    }
    if (!result.sha) return fail(`OBSERVE_TARGET ${result.code}: /api/build ${live ?? 'unreadable'} is not an observable release on main. Nothing was observed; watch-x61 reports the live build.`)
    appendTo(env.GITHUB_OUTPUT, `sha=${result.sha}\n`)
    appendTo(env.GITHUB_STEP_SUMMARY, `Observing the live build ${result.sha} (${result.code}).\n`)
    return 0
  }
  if (command === 'watch' && args.length === 1) {
    const verdict = await watchVerdict({ repository: String(env.GITHUB_REPOSITORY ?? ''), gh, now, read: (path, headers) => get(path, headers, LIVE_WAIT.requestTimeoutMs) })
    console.log(JSON.stringify({ phase: 'watch', ...verdict }))
    const report = watchReport(verdict)
    appendTo(env.GITHUB_STEP_SUMMARY, `${report.lines.join('\n')}\n`)
    for (const line of report.annotations) console.log(line)
    return report.red ? 1 : 0
  }
  return fail('DEPLOY_GUARD_ARGUMENTS: usage live-build | verify-mirror | configured-account | previous-version | await-live | superseded <label> | observe-target | watch')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code }, () => { console.error('::error title=Deploy guard::DEPLOY_GUARD_FAILED'); process.exitCode = 1 })
}
