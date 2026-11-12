/** Exercises the Ubuntu deployment shell with synthetic credentials and isolated output files; no network. */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEPLOY_INERT_GLOBS } from '../../../ci/deploy-paths.mjs'
import { configuredAccount, AWAIT_LIVE_CEILING_MS } from '../../../ci/deploy-guard.mjs'
import { cloudflareDeploymentPlan } from '../../../../server/deploy-cloudflare.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const workflow = readFileSync(new URL('../../../../.github/workflows/deploy-x61.yml', import.meta.url), 'utf8')
const proposalGate = readFileSync(new URL('../../../../.github/workflows/proposal-gate.yml', import.meta.url), 'utf8')
const observeWorkflow = readFileSync(new URL('../../../../.github/workflows/observe-x61.yml', import.meta.url), 'utf8')
const watchWorkflow = readFileSync(new URL('../../../../.github/workflows/watch-x61.yml', import.meta.url), 'utf8')
const wranglerToml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')
/** Top-level job bodies of a workflow, keyed by job id. */
const jobsOf = text => Object.fromEntries(text.split('\njobs:\n')[1].split(/\n(?=  [a-z][a-z0-9-]*:\n)/).map(block => {
  const [first, ...rest] = block.replace(/^\n+/, '').split('\n')
  // A comment block that introduces the NEXT job is not part of this one.
  return [first.trim().replace(/:$/, ''), rest.join('\n').replace(/(?:\n  #[^\n]*|\n[ \t]*)+$/, '\n')]
}).filter(([name]) => /^[a-z][a-z0-9-]*$/.test(name)))
const JOBS = jobsOf(workflow)
const deploy = JOBS.deploy
const OBSERVE_JOBS = jobsOf(observeWorkflow)
const observe = OBSERVE_JOBS.observe
const stepIn = (section, label) => name => {
  const value = section.split(`      - name: ${name}\n`)[1]
  assert.ok(value, `Missing ${label} step: ${name}`)
  return value.split('\n      - name: ')[0]
}
const step = stepIn(deploy, 'deployment')
const observeStep = stepIn(observe, 'observe')
const runLines = text => [...text.matchAll(/^ {8}run: (?!\|)(.+)$/gm)].map(match => match[1])
const script = value => {
  const body = value.split('        run: |\n')[1]
  assert.ok(body, 'Expected a literal shell script')
  return body.split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n')
}
const credentials = step('Require Cloudflare credentials')
const publish = step('Deploy the scrubbed Worker bundle to Cloudflare')
const current = step("Publish only main's newest commit")
const statusBefore = step('Read the live Worker deployment before deploying')
const previous = step('Record the live Worker version and the rollback command')
const confirm = step('Confirm the new build is live')
const stamp = step('Stamp SOURCE_REVISION to the target commit')
const target = stepIn(JOBS.target, 'target')("Resolve main's head")
const shellTest = { skip: process.platform === 'win32' ? 'Deployment runs under Bash on Ubuntu, not Windows' : false }
// The deploy job runs `node deploy/ci/...` from the checkout root; these tests do the same with this Node.
const NODE_PATH_ENV = { PATH: `${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin` }
function run(source, extraEnv = {}, { cwd } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'x61-deploy-workflow-'))
  try {
    // GitHub supplies regular files. Linux cannot reopen a subprocess socket via /dev/stdout.
    const outputPath = join(root, 'output'), summaryPath = join(root, 'summary')
    writeFileSync(outputPath, ''); writeFileSync(summaryPath, '')
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', source], {
      encoding: 'utf8', timeout: 20000, cwd,
      env: { PATH: '/usr/bin:/bin', GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath, RUNNER_TEMP: root,
        GITHUB_WORKSPACE: '/synthetic-workspace', GITHUB_SHA: 'synthetic-sha', GITHUB_REPOSITORY: 'synthetic/repo', GITHUB_RUN_ID: '4242', ...extraEnv },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    return { ...result, output: readFileSync(outputPath, 'utf8'), summary: readFileSync(summaryPath, 'utf8') }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

const HEAD_A = 'a'.repeat(40), HEAD_B = 'b'.repeat(40), HEAD_C = 'c'.repeat(40)

test('every job works on the target commit; the deploy depends on all gates; observation is another workflow', () => {
  assert.deepEqual(Object.keys(JOBS), ['target', 'preflight', 'build', 'scrub-dist', 'bundle', 'deploy'])
  assert.match(JOBS.target, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
  assert.match(JOBS.target, /sha: \$\{\{ steps\.head\.outputs\.sha \}\}/)
  for (const [job, body] of [...['preflight', 'build', 'scrub-dist', 'bundle', 'deploy'].map(name => [name, JOBS[name]]), ['observe-x61 observe', observe]]) {
    assert.match(body, /^ {4}needs: (?:target|\[target, [^\]]+\])$/m, `${job} needs target, so it is skipped whenever target is`)
    for (const checkout of body.split('uses: actions/checkout@').slice(1)) assert.match(checkout, /^\S+ # v4\.4\.0\n {8}with:\n {10}ref: \$\{\{ needs\.target\.outputs\.sha \}\}\n/, job)
  }
  assert.doesNotMatch(workflow, /github\.sha|GITHUB_SHA[^\n]*(?:SOURCE_REVISION|EXPECT)/, 'nothing publishes or checks the commit that merely triggered the run')
  assert.match(deploy, /^ {4}needs: \[target, preflight, scrub-dist, bundle\]$/m)
  assert.match(deploy, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
  assert.match(deploy, /published: \$\{\{ steps\.publish\.outputs\.published \}\}/)
  assert.match(observe, /^ {4}needs: target\n {4}if: needs\.target\.outputs\.sha != ''\n/m)
  assert.match(credentials, /id: credentials/)
  assert.match(publish, /id: publish\n {8}if: steps\.current\.outputs\.publish == 'true'\n/)
  assert.match(current, /id: current\n {8}if: steps\.previous\.outputs\.version_id != ''\n/)
  assert.match(previous, /id: previous\n {8}if: steps\.status_before\.outcome == 'success'\n/)
  assert.doesNotMatch(workflow, /continue-on-error:/)
  assert.doesNotMatch(workflow, /^\s*if:.*secrets\./m)
  const preflight = JOBS.preflight
  for (const command of ['node --test deploy/ci/*.test.mjs', 'node deploy/ci/scrub-gate.mjs --source', 'node deploy/ci/authority-preflight.mjs', 'node deploy/ci/deploy-guard.mjs verify-mirror']) {
    assert.ok(preflight.includes(command), command)
  }
  assert.ok(preflight.includes('node --test deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs'))
  assert.ok(preflight.includes('deploy/cloudflare/src/__tests__/guest-access-boundary.test.mjs'))
  assert.doesNotMatch(preflight, /secrets\.|continue-on-error:|if:.*configured/)
})

test('the removed cleverness stays removed: no release classifier, no history decision, no automatic rollback, no recovery job', () => {
  for (const text of [workflow, proposalGate]) {
    assert.doesNotMatch(text, /release-range|decide-history|HEAD_SYNC_COPY_ONLY|PUSH_BEFORE|rollback-decision|published-version|wrangler@[0-9.]+ rollback|head-run|schedule:|compare\//)
  }
  assert.doesNotMatch(deploy, /always\(\)[^\n]*rollback|Roll back to/)
})

for (const [name, env] of [
  ['both missing', { HAS_API_TOKEN: 'false', HAS_ACCOUNT_ID: 'false' }],
  ['account missing', { HAS_API_TOKEN: 'true', HAS_ACCOUNT_ID: 'false' }],
  ['token missing', { HAS_API_TOKEN: 'false', HAS_ACCOUNT_ID: 'true' }],
  ['nothing passed', {}],
]) test(`missing credentials: ${name} produces an explicit clean skip`, shellTest, () => {
  const result = run(script(credentials), env)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Auto-deploy skipped until CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are configured as secrets of the production environment/)
  assert.match(result.summary, /Auto-deploy skipped until CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are configured as secrets of the production environment/)
  assert.match(result.summary, /Nothing was deployed; live observation was skipped\./)
  assert.equal(result.output.trim(), 'configured=false')
  assert.doesNotMatch(result.stdout + result.output + result.summary, /configured=true|deployed=true|::error/)
})

test('configured credentials enable deployment without claiming publication, and the presence check sees no value', shellTest, () => {
  const result = run(script(credentials), { HAS_API_TOKEN: 'true', HAS_ACCOUNT_ID: 'true' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output.trim(), 'configured=true')
  assert.equal(result.summary, '')
  assert.equal(result.stdout, '')
  assert.match(credentials, /HAS_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN != '' \}\}/)
  assert.doesNotMatch(credentials, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/)
})

test('publishing emits its output only after Wrangler succeeds; a Wrangler failure is fatal', shellTest, () => {
  const ok = run(`calls=0\nnpx() { calls=$((calls+1)); [ ! -s "$GITHUB_OUTPUT" ] || return 45; [ "$3" = deploy ] || return 46; echo synthetic-wrangler-completed; }\n${script(publish)}\necho "calls=$calls"`)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /synthetic-wrangler-completed\ncalls=1/)
  assert.equal(ok.output.trim(), 'published=true')
  assert.match(ok.summary, /whether it is live is decided by \/api\/build below/)
  const failed = run(`npx() { return 23; }\n${script(publish)}`)
  assert.equal(failed.status, 23)
  assert.equal(failed.output, '')
  assert.equal(failed.summary, '')
})

/**
 * Rule 1: the two places that decide WHICH commit, run against a synthetic GitHub. `gh` answers
 * main's head and records any dispatch; nothing else is consulted.
 */
const YAML_BLOB = '9'.repeat(40)
/** `blobs` maps a commit to the blob of deploy-x61.yml in it (default: the same file in every commit). */
const ghStub = (mainHead, blobs = {}) => `gh() { case "$*" in *commits/main*) printf '%s\\n' '${mainHead}' ;; ${Object.entries(blobs).map(([sha, blob]) => `*"contents/.github/workflows/deploy-x61.yml?ref=${sha} "*) printf '%s\\n' '${blob}' ;; `).join('')}*contents/.github/workflows/deploy-x61.yml*) printf '%s\\n' '${YAML_BLOB}' ;; "workflow run"*) printf 'DISPATCHED %s\\n' "$*" ;; *) return 41 ;; esac; }\n`
// A re-run executes the YAML of the run it re-runs: github.workflow_sha is the commit that started it.
const resolve = (mainHead, triggerSha, event, blobs) => run(`${ghStub(mainHead, blobs)}${script(target)}`, { GITHUB_SHA: triggerSha, WORKFLOW_SHA: triggerSha, GITHUB_EVENT_NAME: event })
const gate = (mainHead, targetSha) => run(`${ghStub(mainHead)}${script(current)}`, { TARGET_SHA: targetSha })
const targetOf = result => { assert.equal(result.status, 0, result.stderr); return result.output.match(/^sha=([0-9a-f]{40})$/m)[1] }
const publishes = result => { assert.equal(result.status, 0, result.stderr); assert.equal(result.output, 'publish=true\n'); assert.doesNotMatch(result.stdout, /DISPATCHED/) }
const supersededAndDispatched = (result, mainHead, targetSha) => {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.output, 'publish=false\n')
  // Exactly one dispatch, for main: that run resolves main's head, so the head is never stranded.
  assert.equal([...result.stdout.matchAll(/DISPATCHED/g)].length, 1)
  assert.match(result.stdout, /DISPATCHED workflow run deploy-x61\.yml --repo synthetic\/repo --ref main -f reason=superseded by /)
  assert.match(result.summary, new RegExp(`^superseded by ${mainHead}: main moved after this run resolved ${targetSha}\\. Nothing was published`))
}

test('rule 1: a re-run of an old run (all jobs) builds and publishes main\'s head, never the commit that started it', shellTest, () => {
  const resolved = targetOf(resolve(HEAD_C, HEAD_A, 'push'))
  assert.equal(resolved, HEAD_C)
  publishes(gate(HEAD_C, resolved))
})

test('rule 1: a single-job re-run keeps the old target, so the deploy refuses to publish it and dispatches main once', shellTest, () => {
  // GitHub keeps the earlier attempt's target output (HEAD_A) when only the deploy job is re-run; main is now HEAD_C.
  supersededAndDispatched(gate(HEAD_C, HEAD_A), HEAD_C, HEAD_A)
  // The dispatched run resolves main's head and publishes it.
  publishes(gate(HEAD_C, targetOf(resolve(HEAD_C, HEAD_C, 'workflow_dispatch'))))
})

test('rule 1: a manual dispatch on an old commit can only publish main\'s head; off main nothing runs at all', shellTest, () => {
  const resolved = targetOf(resolve(HEAD_C, HEAD_A, 'workflow_dispatch'))
  assert.equal(resolved, HEAD_C)
  publishes(gate(HEAD_C, resolved))
  // Dispatched on another ref: the target job does not run, and every other job needs it; the queue is not main's.
  assert.match(JOBS.target, /^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
  assert.match(workflow, /\nconcurrency:\n {2}# [^\n]*\n {2}group: \$\{\{ github\.ref == 'refs\/heads\/main' && 'deploy-x61-publish-main' \|\| format\('deploy-x61-not-main-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: false\n/)
})

test('rule 1: main moving during the build stops the publication and starts one run for the new head', shellTest, () => {
  const resolved = targetOf(resolve(HEAD_B, HEAD_B, 'push'))
  supersededAndDispatched(gate(HEAD_C, resolved), HEAD_C, HEAD_B)
  publishes(gate(HEAD_C, targetOf(resolve(HEAD_C, HEAD_B, 'workflow_dispatch'))))
})

test('rule 1: a re-run whose own workflow file is not main\'s builds and publishes nothing and dispatches main once (review S3)', shellTest, () => {
  // Run L re-run after M changed deploy-x61.yml: GitHub runs L's YAML, so L's gates must not publish M's head.
  const stale = resolve(HEAD_C, HEAD_A, 'push', { [HEAD_A]: '1'.repeat(40), [HEAD_C]: '2'.repeat(40) })
  assert.equal(stale.status, 0, stale.stderr)
  assert.equal(stale.output, '', 'no target: every later job is skipped')
  assert.equal([...stale.stdout.matchAll(/DISPATCHED/g)].length, 1)
  assert.match(stale.stdout, /DISPATCHED workflow run deploy-x61\.yml --repo synthetic\/repo --ref main -f reason=workflow file changed /)
  assert.match(stale.summary, new RegExp(`deploy-x61\\.yml as of ${HEAD_A}, which is not the file at main's head ${HEAD_C}\\. Nothing was built or published`))
  // The same file at both commits: the run proceeds on main's head as before.
  assert.equal(targetOf(resolve(HEAD_C, HEAD_A, 'push', { [HEAD_A]: '1'.repeat(40), [HEAD_C]: '1'.repeat(40) })), HEAD_C)
  // An unreadable file, a missing workflow commit or a failed dispatch fails loudly and names no target.
  for (const [blobs, env] of [[{ [HEAD_C]: 'nope' }, {}], [{}, { WORKFLOW_SHA: '' }], [{ [HEAD_A]: '1'.repeat(40) }, { NO_DISPATCH: '1' }]]) {
    const stub = env.NO_DISPATCH ? ghStub(HEAD_C, blobs).replace(`"workflow run"*) printf 'DISPATCHED %s\\n' "$*" ;;`, '"workflow run"*) return 33 ;;') : ghStub(HEAD_C, blobs)
    const failed = run(`${stub}${script(target)}`, { GITHUB_SHA: HEAD_A, WORKFLOW_SHA: HEAD_A, GITHUB_EVENT_NAME: 'push', ...env })
    assert.notEqual(failed.status, 0, JSON.stringify(blobs))
    assert.doesNotMatch(failed.output, /sha=/)
  }
  // Every job that checks out the target is skipped when there is none; scrub-dist, deploy and observe follow them.
  assert.match(JOBS.target, /^ {4}permissions:\n {6}actions: write\n {6}contents: read\n/m)
  assert.match(target, /WORKFLOW_SHA: \$\{\{ github\.workflow_sha \}\}/)
  for (const job of ['preflight', 'build', 'bundle']) assert.match(JOBS[job], /^ {4}needs: target\n {4}if: needs\.target\.outputs\.sha != ''\n/m, job)
  assert.match(JOBS['scrub-dist'], /^ {4}needs: \[target, build\]$/m)
})

test('rule 1: an unreadable head or a failed dispatch fails loudly; nothing is published either way', shellTest, () => {
  for (const source of [`gh() { return 29; }\n${script(target)}`, `gh() { printf 'not-a-sha\\n'; }\n${script(target)}`]) {
    const failed = run(source)
    assert.notEqual(failed.status, 0)
    assert.equal(failed.output, '')
  }
  for (const source of [`gh() { return 29; }\n${script(current)}`, `gh() { printf ''; }\n${script(current)}`]) {
    const failed = run(source, { TARGET_SHA: HEAD_A })
    assert.notEqual(failed.status, 0)
    assert.doesNotMatch(failed.output, /publish=true/)
  }
  const noDispatch = run(`gh() { case "$*" in *commits/main*) printf '%s\\n' '${HEAD_C}' ;; *) return 31 ;; esac; }\n${script(current)}`, { TARGET_SHA: HEAD_A })
  assert.equal(noDispatch.status, 31)
  assert.doesNotMatch(noDispatch.output, /publish=true/)
})

test('the stamped SOURCE_REVISION is the target commit, never the trigger', shellTest, () => {
  const dir = mkdtempSync(join(tmpdir(), 'x61-stamp-'))
  try {
    writeFileSync(join(dir, 'placeholder'), '')
    const toml = join(dir, 'deploy/cloudflare')
    spawnSync('/bin/mkdir', ['-p', toml])
    writeFileSync(join(toml, 'wrangler.toml'), 'name = "your-node"\n[vars]\nSOURCE_REVISION = "0000000"\n')
    const stamped = run(script(stamp), { ...NODE_PATH_ENV, TARGET_SHA: HEAD_C, GITHUB_SHA: HEAD_A }, { cwd: dir })
    assert.equal(stamped.status, 0, stamped.stderr)
    assert.match(readFileSync(join(toml, 'wrangler.toml'), 'utf8'), new RegExp(`SOURCE_REVISION = "${HEAD_C}"`))
    assert.equal(run(script(stamp), { ...NODE_PATH_ENV, TARGET_SHA: '' }, { cwd: dir }).status, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('before publishing: the live version, the exact rollback command and the dead-runner sentence are recorded; the account is pinned', shellTest, () => {
  const account = configuredAccount(wranglerToml)
  assert.match(account, /^[0-9a-f]{32}$/)
  const version = '0f0e0d0c-0b0a-4908-8706-050403020100'
  const read = run(`npx() { printf '%s' '{"id":"d","versions":[{"version_id":"${version}","percentage":100}]}'; }\n${script(statusBefore)}\ncat "$RUNNER_TEMP/x61-deployment-status.json"`,
    { CLOUDFLARE_ACCOUNT_ID: account, PINNED_ACCOUNT: account })
  assert.equal(read.status, 0, read.stderr)
  assert.match(read.stdout, new RegExp(version))
  const wrongAccount = run(`npx() { return 0; }\n${script(statusBefore)}`, { CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32), PINNED_ACCOUNT: account })
  assert.equal(wrongAccount.status, 1)
  assert.match(wrongAccount.stdout, /ACCOUNT_MISMATCH/)
  const record = body => run(`printf '%s' '${body}' > "$RUNNER_TEMP/x61-deployment-status.json"\n${script(previous)}`, NODE_PATH_ENV, { cwd: REPO_ROOT })
  const ok = record(`{"id":"d","versions":[{"version_id":"${version}","percentage":100}]}`)
  assert.equal(ok.status, 0, ok.stderr)
  const command = `gh workflow run rollback-x61.yml --repo synthetic/repo --ref main -f version_id=${version}`
  assert.equal(ok.output, `version_id=${version}\nrollback_command=${command}\n`)
  assert.match(ok.summary, new RegExp(`Live Worker version before this deploy: ${version}\\.`))
  assert.ok(ok.summary.includes(`Rollback command: \`${command}\``))
  assert.match(ok.summary, /^publication pending verification; if this runner dies the release stays live unchecked$/m)
  const split = record(`{"versions":[{"version_id":"${version}","percentage":60},{"version_id":"${version.replace('0f', '1f')}","percentage":40}]}`)
  assert.equal(split.status, 1)
  assert.equal(split.output, '')
  assert.match(split.stdout, /Nothing was deployed/)
  const pinned = run(script(step('Read the pinned Cloudflare account (no secret)')), NODE_PATH_ENV, { cwd: REPO_ROOT })
  assert.equal(pinned.output.trim(), `account_id=${account}`)
  // Order: recorded before the head is re-read, which is immediately before publishing; the check comes after.
  const order = ['Read the live Worker deployment before deploying', 'Record the live Worker version and the rollback command', "Publish only main's newest commit",
    'Deploy the scrubbed Worker bundle to Cloudflare', 'Confirm the new build is live']
  for (let index = 1; index < order.length; index++) assert.ok(deploy.indexOf(`- name: ${order[index - 1]}\n`) < deploy.indexOf(`- name: ${order[index]}\n`), order[index])
  assert.ok(deploy.trimEnd().endsWith(confirm.trimEnd()), 'the check is the last step: nothing runs after it, no rollback')
})

test('the cloud deploy carries the same compatibility flags and empty env file as the Mac deploy', () => {
  const plan = cloudflareDeploymentPlan([], { name: 'your-node', account_id: 'a'.repeat(32) }, {})
  const flags = plan.args.flatMap((value, index) => value === '--compatibility-flags' ? [plan.args[index + 1]] : [])
  assert.ok(flags.length >= 2, 'the Mac deploy names its compatibility flags')
  const command = script(publish)
  for (const flag of flags) assert.ok(command.includes(`--compatibility-flags ${flag}`), flag)
  assert.ok(plan.args.includes('--env-file'))
  assert.match(command, /--env-file \/dev\/null/)
  assert.equal([...command.matchAll(/--compatibility-flags /g)].length, flags.length)
})

test('after publishing: the check reads /api/build and the sign-in page; a failure is loud, names the rollback command and rolls nothing back', shellTest, () => {
  assert.ok(confirm.includes("if: ${{ always() && steps.publish.outcome != 'skipped' }}"))
  assert.match(confirm, /X61_EXPECT_BUILD_SHA: \$\{\{ needs\.target\.outputs\.sha \}\}/)
  assert.doesNotMatch(confirm, /secrets\./)
  const env = { X61_EXPECT_BUILD_SHA: HEAD_C, ROLLBACK_COMMAND: 'gh workflow run rollback-x61.yml --repo synthetic/repo --ref main -f version_id=0f0e0d0c-0b0a-4908-8706-050403020100' }
  const live = run(`node() { [ "$2" = await-live ] || return 9; return 0; }\n${script(confirm)}`, env)
  assert.equal(live.status, 0)
  assert.match(live.summary, /Live check passed: \/api\/build reports c{40}/)
  for (const [code, why] of [[1, /\/api\/build did not report c{40}/], [3, /could not reach Cloudflare's edge/]]) {
    const failed = run(`node() { return ${code}; }\nnpx() { echo NPX-CALLED; }\n${script(confirm)}`, env)
    assert.equal(failed.status, 1)
    assert.match(failed.stdout, /::error title=Deploy not verified::NOT VERIFIED LIVE: /)
    assert.match(failed.stdout, why)
    assert.ok(failed.summary.includes(`Nothing was rolled back. To roll back: ${env.ROLLBACK_COMMAND}`))
    assert.doesNotMatch(failed.stdout, /NPX-CALLED/)
  }
  const minutes = text => Number(text.match(/timeout-minutes: (\d+)/)?.[1])
  const steps = deploy.split('\n    steps:\n')[1].split(/\n(?= {6}- name: )/)
  for (const value of steps) assert.ok(Number.isInteger(minutes(value)), `every deploy step has its own timeout: ${value.slice(0, 80)}`)
  assert.ok(steps.reduce((sum, value) => sum + minutes(value), 0) + 3 <= minutes(deploy), 'the steps fit inside the job timeout')
  assert.ok(AWAIT_LIVE_CEILING_MS <= minutes(confirm) * 60_000 - 30_000, 'the await-live ceiling ends inside the check step')
})

test('docs-only pushes start no deploy: paths-ignore equals the deploy-inert list', () => {
  const block = workflow.split('\n  push:\n')[1].split('\n  workflow_dispatch:')[0]
  const ignored = [...block.split('paths-ignore:\n')[1].matchAll(/^ {6}- "([^"]+)"$/gm)].map(match => match[1])
  assert.deepEqual(ignored, [...DEPLOY_INERT_GLOBS])
  assert.doesNotMatch(block, /\n {4}paths:/)
})

test('one queue: one workflow-level group for main that never cancels and keeps every pending run; no job-level or gate-level groups at all', () => {
  assert.equal([...workflow.matchAll(/^\s*concurrency:/gm)].length, 1)
  assert.match(workflow.split('\njobs:\n')[0], /^concurrency:\n/m)
  // queue: max as GitHub's workflow-syntax page documents it (read 2026-11-12): up to 100 pending runs, first in first out,
  // instead of one pending run that a newcomer replaces. It may not be combined with cancel-in-progress: true.
  assert.match(workflow.split('\njobs:\n')[0], /\n {2}cancel-in-progress: false\n {2}queue: max\n/)
  assert.doesNotMatch(workflow, /cancel-in-progress: true/)
  for (const [name, body] of Object.entries(JOBS)) assert.doesNotMatch(body, /concurrency:/, name)
  // The rollback has its own group (review S2): in deploy-x61's group GitHub keeps one pending run, so a later push would
  // silently cancel a pending rollback, or a rollback would cancel the pending deploy of main's head. Nothing evicts it now.
  const rollback = readFileSync(new URL('../../../../.github/workflows/rollback-x61.yml', import.meta.url), 'utf8')
  assert.match(rollback, /\nconcurrency:\n {2}group: \$\{\{ github\.ref == 'refs\/heads\/main' && 'rollback-x61-main' \|\| format\('rollback-x61-not-main-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: false\n/)
  assert.doesNotMatch(rollback, /deploy-x61-main/)
  assert.equal([...rollback.matchAll(/^\s*concurrency:/gm)].length, 1)
})

test('rollback-x61: dispatch only, main only, production, the credential only on the one Wrangler step, then a report from /api/build', shellTest, () => {
  const text = readFileSync(new URL('../../../../.github/workflows/rollback-x61.yml', import.meta.url), 'utf8')
  assert.match(text, /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}version_id:\n/m)
  assert.doesNotMatch(text.split('\npermissions:')[0], /push:|schedule:|workflow_run:|pull_request/)
  const jobs = jobsOf(text)
  assert.deepEqual(Object.keys(jobs), ['rollback'])
  assert.match(jobs.rollback, /^ {4}if: github\.ref == 'refs\/heads\/main'\n {4}runs-on: ubuntu-latest\n {4}timeout-minutes: \d+\n {4}environment: production\n/m)
  const steps = jobs.rollback.split(/\n(?= {6}- name: )/).slice(1)
  assert.deepEqual(steps.filter(value => /secrets\./.test(value)).map(value => value.match(/- name: (.+)/)[1]), ['Roll back the Worker'])
  const wrangler = stepIn(jobs.rollback, 'rollback')('Roll back the Worker')
  const version = '0f0e0d0c-0b0a-4908-8706-050403020100', account = 'a'.repeat(32)
  const rolled = run(`npx() { printf 'NPX %s\\n' "$*"; }\n${script(wrangler)}`, { VERSION_ID: version, CLOUDFLARE_ACCOUNT_ID: account, PINNED_ACCOUNT: account })
  assert.equal(rolled.status, 0, rolled.stderr)
  assert.match(rolled.stdout, new RegExp(`^NPX --yes wrangler@4\\.155\\.0 rollback ${version} --config deploy/cloudflare/wrangler\\.toml --env-file /dev/null --message .* -y$`, 'm'))
  for (const env of [{ VERSION_ID: 'x; rm -rf /', CLOUDFLARE_ACCOUNT_ID: account, PINNED_ACCOUNT: account }, { VERSION_ID: version, CLOUDFLARE_ACCOUNT_ID: 'f'.repeat(32), PINNED_ACCOUNT: account }, { VERSION_ID: version, CLOUDFLARE_ACCOUNT_ID: '', PINNED_ACCOUNT: '' }]) {
    const refused = run(`npx() { echo NPX-CALLED; }\n${script(wrangler)}`, env)
    assert.notEqual(refused.status, 0)
    assert.doesNotMatch(refused.stdout, /NPX-CALLED/)
  }
  const input = stepIn(jobs.rollback, 'rollback')('Check the version id and read the pinned account (no secret)')
  assert.equal(run(`node() { echo x; }\n${script(input)}`, { VERSION_ID: 'not-a-version' }).status, 1)
  const report = stepIn(jobs.rollback, 'rollback')('Report what /api/build says now (no secret)')
  assert.match(report, /if: always\(\)/)
  const said = run(`node() { [ "$2" = live-build ] && printf '%s' '${HEAD_A}'; }\n${script(report)}`, { VERSION_ID: version, LIVE_BEFORE: HEAD_C })
  assert.match(said.summary, new RegExp(`Rollback to Worker version ${version}: /api/build reported c{40} before and reports a{40} now\\.`))
})

test('watch-x61 only reports: schedule and manual runs only, contents: read and nothing else, no secret, and the verdict is the guard\'s watch', () => {
  const text = watchWorkflow
  const header = text.split('\njobs:\n')[0]
  // No workflow_run: it is not started by deploy runs (or by any other workflow's run).
  assert.match(header, /^on:\n {2}schedule:\n {4}- cron: "7 \*\/2 \* \* \*"\n {2}workflow_dispatch:\n\npermissions:\n {2}contents: read\n\n/m)
  assert.doesNotMatch(text, /workflow_run|push:|pull_request|repository_dispatch/)
  // Its token can write nothing: the one permissions block grants contents: read, and no job widens it.
  assert.equal([...text.matchAll(/^\s*permissions:/gm)].length, 1)
  assert.doesNotMatch(text, /:\s*write\b|write-all|actions:/)
  assert.match(text, /\nconcurrency:\n {2}group: watch-x61\n {2}cancel-in-progress: false\n/)
  // It runs the guard's watch and nothing else that could act: no gh command line, no curl, no secret, no environment.
  assert.deepEqual(runLines(text), ['node deploy/ci/deploy-guard.mjs watch'])
  assert.doesNotMatch(text, /\bgh (?:workflow|run|api)\b|curl|secrets\.|environment:|CLOUDFLARE_|wrangler/)
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}\n {8}run: node deploy\/ci\/deploy-guard\.mjs watch/)
  assert.ok(text.trimEnd().endsWith('run: node deploy/ci/deploy-guard.mjs watch'))
  // The header says plainly who recovers a stranded release.
  assert.match(header, /A STRANDED RELEASE IS RECOVERED BY A PERSON: they run deploy-x61\.yml/)
  assert.match(header, /The watcher only reports\./)
})

test('observe runs the signed-out checks with no secret, labels partial coverage, and both observations handle supersession', shellTest, () => {
  const signedOut = observeStep('Signed-out checks in three engines (no secret)')
  assert.match(signedOut, /id: signedout/)
  assert.match(script(signedOut), /^if node deploy\/ci\/observe-signed-out-x61\.mjs --out /)
  assert.match(signedOut, /X61_EXPECT_BUILD_SHA: \$\{\{ needs\.target\.outputs\.sha \}\}/)
  assert.doesNotMatch(signedOut, /secrets\.|\n {8}if:/)
  // Signed-out only: neither the owner-credential step nor the signed-in windows exist any more.
  assert.doesNotMatch(observe, /Owner credential for the signed-in windows|Observe six fresh windows|observe-fresh-x61\.mjs --out|secrets\./)
  const nodeStub = (observed, superseded) => `node() { if [ "$2" = superseded ]; then echo "SUPERSEDED-CHECK $3"; return ${superseded}; fi; return ${observed}; }\n`
  assert.equal(run(`${nodeStub(0, 1)}${script(signedOut)}`).status, 0)
  const failed = run(`${nodeStub(4, 1)}${script(signedOut)}`)
  assert.equal(failed.status, 4)
  assert.match(failed.stdout, /SUPERSEDED-CHECK signed-out/)
  assert.equal(run(`${nodeStub(4, 0)}${script(signedOut)}`).status, 0)
  const report = observeStep('Report what was and was not performed')
  assert.match(report, /if: always\(\)/)
  // The aggregate comes from what was performed; a PARTIAL run says what was not.
  const partial = run(script(report), { TARGET_SHA: HEAD_C, SIGNED_OUT: 'success', SIGNED_OUT_VERDICT: 'PARTIAL', SIGNED_OUT_UNPERFORMED: 'webkit:passkey' })
  assert.match(partial.summary, /^### Live observation of c{40}$/m)
  assert.match(partial.summary, /Signed-out checks in Chromium, Firefox and WebKit .*: PARTIAL \(step success\)/)
  assert.match(partial.summary, /- PARTIAL coverage\. Not performed: webkit:passkey/)
  assert.doesNotMatch(partial.summary, /: success\n/)
  const unperformed = /Signed-in six-window observation: UNPERFORMED \(CI observes signed out only; the owner credential is never a CI secret\)\. Nothing signed-in was checked\./
  assert.match(partial.summary, unperformed)
  const full = run(script(report), { SIGNED_OUT: 'success', SIGNED_OUT_VERDICT: 'PASS' })
  assert.match(full.summary, /: PASS \(step success\)/)
  assert.match(full.summary, unperformed, 'every run says nothing signed-in was checked')
  assert.doesNotMatch(full.summary, /PARTIAL|SUPERSEDED/)
  const over = run(script(report), { SIGNED_OUT: 'success', SUPERSEDED: 'b'.repeat(40) })
  assert.match(over.summary, /SUPERSEDED by the newer live release b{40}: this observation counts neither way\./)
})

test('proposal gate: her proposal branches get the deploy gates byte for byte, with no secret and no deploy', () => {
  assert.match(proposalGate, /^on:\n  push:\n    branches:\n      - "auma\/proposal\/\*\*"\n\n/m)
  assert.match(proposalGate, /^permissions:\n  contents: read\n/m)
  assert.doesNotMatch(proposalGate, /secrets\.|continue-on-error:|workflow_dispatch|pull_request|rollback|deployments status|environment:|\bgh (?:api|workflow) /)
  for (const line of proposalGate.split('\n').filter(text => /wrangler@/.test(text))) assert.match(line, /deploy --dry-run /)
  const gate = jobsOf(proposalGate), main = JOBS
  assert.deepEqual(Object.keys(gate), ['target', 'preflight', 'build', 'scrub-dist', 'bundle'])
  // Its target is the pushed proposal commit itself, never main.
  assert.equal(runLines(gate.target).join('\n'), 'echo "sha=$GITHUB_SHA" >> "$GITHUB_OUTPUT"')
  // The same gate jobs as the deploy of main, so a passed card means the deploy gates passed on those bytes.
  for (const job of ['preflight', 'build', 'scrub-dist', 'bundle']) assert.equal(gate[job], main[job], job)
})

/**
 * GitHub's concurrency queue as its workflow-syntax page states it (read 2026-11-12): a run in progress is never cancelled
 * (cancel-in-progress false); with `queue: single` (the default) at most one run waits, and a newcomer cancels and replaces
 * it; with `queue: max` up to 100 wait, first in first out, and a newcomer beyond that is cancelled.
 */
function githubQueues() {
  const groups = new Map(), cancelled = []
  const group = name => { if (!groups.has(name)) groups.set(name, { running: null, pending: [] }); return groups.get(name) }
  return {
    cancelled,
    group,
    enqueue(name, mode, run) {
      const queue = group(name)
      if (!queue.running) { queue.running = run; return }
      if (mode === 'max') { if (queue.pending.length >= 100) cancelled.push(run); else queue.pending.push(run); return }
      cancelled.push(...queue.pending)
      queue.pending = [run]
    },
    finish(name) { const queue = group(name); queue.running = queue.pending.shift() ?? null; return queue.running },
  }
}
/** The group a workflow's runs on main join and its queue mode, read from the workflow file itself. */
const queueOf = text => {
  const header = text.split('\njobs:\n')[0]
  const group = header.match(/\nconcurrency:\n(?: {2}#[^\n]*\n)* {2}group: ([^\n]+)\n/)[1]
  return { name: group.match(/== 'refs\/heads\/main' && '([^']+)'/)?.[1] ?? group.trim(), mode: /\n {2}queue: max\n/.test(header) ? 'max' : 'single' }
}

test('every job in the deploy queue leads to the publish guard: a re-run of any one of them (GitHub re-runs its dependents too) reaches it (review loop3 MUST)', () => {
  const needs = Object.fromEntries(Object.entries(JOBS).map(([name, body]) => {
    const line = body.match(/^ {4}needs: (.+)$/m)?.[1] ?? ''
    return [name, line.replace(/^\[|\]$/g, '').split(',').map(value => value.trim()).filter(Boolean)]
  }))
  const withDependents = name => {
    const found = new Set([name])
    for (let grew = true; grew;) {
      grew = false
      for (const [job, list] of Object.entries(needs)) if (!found.has(job) && list.some(item => found.has(item))) { found.add(job); grew = true }
    }
    return found
  }
  for (const name of Object.keys(JOBS)) assert.ok(withDependents(name).has('deploy'), `a re-run of ${name} reaches the deploy job`)
  assert.ok(deploy.includes("      - name: Publish only main's newest commit\n"))
  // Nothing in the deploy workflow observes; observation is observe-x61.yml.
  assert.doesNotMatch(workflow, /observe-signed-out|observe-fresh|X61_OWNER_JWT|playwright/i)
})

/** The group name every earlier deploy-x61 run used, including two historical versions of this workflow whose file
 * still has an `observe` job and no `queue: max` (GitHub re-runs a run with its own old file). */
const HISTORICAL_DEPLOY_GROUP = Object.freeze({ name: 'deploy-x61-main', mode: 'single' })

test('the reviewer\'s sequence (review loop3 MUST, loop4 SHOULD 4): no re-run of an old observation, current or historical, can displace the pending deploy of the newest commit', shellTest, () => {
  const deployQueue = queueOf(workflow), observeQueue = queueOf(observeWorkflow)
  assert.deepEqual(deployQueue, { name: 'deploy-x61-publish-main', mode: 'max' })
  assert.deepEqual(observeQueue, { name: 'observe-x61', mode: 'single' })
  // The deploy queue's name is new and stable: no workflow file uses the historical name any more, and none but this one
  // uses the new name.
  assert.notEqual(deployQueue.name, HISTORICAL_DEPLOY_GROUP.name)
  for (const name of readdirSync(new URL('../../../../.github/workflows/', import.meta.url)).filter(file => /\.ya?ml$/.test(file))) {
    const text = readFileSync(new URL(`../../../../.github/workflows/${name}`, import.meta.url), 'utf8')
    const groups = text.split('\n').filter(line => /^\s*group:/.test(line)).join('\n')
    assert.doesNotMatch(groups, /deploy-x61-main\b(?!-)/, name)
    if (name !== 'deploy-x61.yml') assert.doesNotMatch(groups, /deploy-x61-publish-main/, name)
  }
  const q = githubQueues()
  q.enqueue(deployQueue.name, deployQueue.mode, 'A') // run A is publishing
  q.enqueue(deployQueue.name, deployQueue.mode, 'B') // commit B lands on main: its run waits
  // Someone re-runs only the observation of an older run. A current one runs observe-x61.yml (its own group); a
  // HISTORICAL one runs its old deploy-x61.yml, whose observe job sits in the old deploy group.
  q.enqueue(observeQueue.name, observeQueue.mode, 'C observe re-run')
  q.enqueue(HISTORICAL_DEPLOY_GROUP.name, HISTORICAL_DEPLOY_GROUP.mode, 'H observe re-run (historical file)')
  q.enqueue(HISTORICAL_DEPLOY_GROUP.name, HISTORICAL_DEPLOY_GROUP.mode, 'H2 observe re-run (historical file)')
  assert.deepEqual(q.group(deployQueue.name).pending, ['B'])
  // The historical re-runs queue among themselves in the old group; nothing of main's deploy is touched.
  assert.equal(q.group(HISTORICAL_DEPLOY_GROUP.name).running, 'H observe re-run (historical file)')
  assert.deepEqual(q.group(HISTORICAL_DEPLOY_GROUP.name).pending, ['H2 observe re-run (historical file)'])
  assert.deepEqual(q.cancelled, [])
  // Even a re-run of a job of a current run C inside the deploy queue no longer replaces B: queue max keeps both waiting.
  q.enqueue(deployQueue.name, deployQueue.mode, 'C preflight re-run')
  assert.deepEqual(q.group(deployQueue.name).pending, ['B', 'C preflight re-run'])
  // The single queue the deploy had before (the historical group) would have cancelled B there. Nothing re-starts a lost
  // run automatically now: watch-x61 reports it and a person runs the deploy by hand.
  const single = githubQueues()
  for (const run of ['A', 'B', 'C']) single.enqueue(HISTORICAL_DEPLOY_GROUP.name, HISTORICAL_DEPLOY_GROUP.mode, run)
  assert.deepEqual(single.cancelled, ['B'])
  // A finishes; B runs, resolves main's head B and publishes it.
  assert.equal(q.finish(deployQueue.name), 'B')
  publishes(gate(HEAD_B, targetOf(resolve(HEAD_B, HEAD_B, 'push'))))
  // C's re-run kept its old target A (outputs of jobs not re-run are kept): its deploy publishes nothing and dispatches main.
  assert.equal(q.finish(deployQueue.name), 'C preflight re-run')
  supersededAndDispatched(gate(HEAD_B, HEAD_A), HEAD_B, HEAD_A)
})

test('observe-x61: after each deploy-x61 run on main (or a dispatch on main), its own queue, no Cloudflare credential, no environment', shellTest, () => {
  assert.match(observeWorkflow, /^on:\n {2}workflow_run:\n {4}workflows: \["Deploy your-node to Cloudflare"\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n {2}workflow_dispatch:\n\npermissions:\n {2}contents: read\n/m)
  assert.match(observeWorkflow, /\nconcurrency:\n {2}group: observe-x61\n {2}cancel-in-progress: false\n/)
  assert.doesNotMatch(observeWorkflow, /deploy-x61-main|CLOUDFLARE_|environment:|wrangler|actions: write/)
  assert.deepEqual(Object.keys(OBSERVE_JOBS), ['target', 'observe'])
  const target = OBSERVE_JOBS.target
  assert.match(target, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/)
  assert.match(target, /github\.event\.workflow_run\.head_branch == 'main' && github\.event\.workflow_run\.conclusion == 'success'/)
  assert.match(target, /^ {4}permissions:\n {6}actions: read\n {6}contents: read\n/m)
  assert.doesNotMatch(target, /secrets\./)
  const resolveStep = stepIn(target, 'observe target')('Resolve the published live build (no secret)')
  assert.match(resolveStep, /OBSERVE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/)
  assert.match(resolveStep, /run: node deploy\/ci\/deploy-guard\.mjs observe-target\n/)
  assert.match(target, /sha: \$\{\{ steps\.target\.outputs\.sha \}\}/)
})
