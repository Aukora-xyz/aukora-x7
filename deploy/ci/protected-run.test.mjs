// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/protected-run.test.mjs  (throwaway folders in the OS temp folder; no network, no install)
//
// Review, MUST 1: in the protected jobs of .github/workflows/proposal-checks.yml (edge, ui, boot) the code a
// suite runs is partly hers (an open file such as crew-relay-tool.mjs, which main's relay test imports). Before this
// change the judge, a results file and an exit file sat in RUNNER_TEMP between steps, so that code could rewrite the judge
// and the next step said green. These tests run every step each protected job runs after its install, exactly as written
// in the workflow (expressions filled in as GitHub fills them, the runner's bash, stopping at the first red step), with
// main's judge where the put-back step writes it. A job is green only when every one of its steps is.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packNames } from './retention.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const JUDGE = fileURLToPath(new URL('./retention.mjs', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/proposal-checks.yml'), 'utf8')
const MESSAGES_FILES = /\n {2}MESSAGES_FILES: (.+)\n/.exec(WORKFLOW)[1]
const CONFIG_PATHS = /CONFIG_PATHS: >-\n((?: {4}.+\n)+)/.exec(WORKFLOW)[1].split(/\s+/).filter(Boolean).join(' ')

/** Every step of a job after its install, as GitHub runs them: { name, env, script }. */
function stepsAfterInstall(job) {
  const text = WORKFLOW.split(`\n  ${job}:\n`)[1].split(/\n {2}[a-z][a-z-]*:\n/)[0]
  const after = text.split('      - name: Install dependencies without lifecycle scripts\n')[1]
  return after.split(/\n {6}- name: /).slice(1).map(chunk => {
    const lines = chunk.split('\n'), env = {}, body = []
    let script = null
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index], variable = /^ {10}([A-Z_]+): (.+)$/.exec(line)
      if (variable && script === null) env[variable[1]] = variable[2]
      if (line === '        run: |') {
        for (const next of lines.slice(index + 1)) { if (!next.startsWith('          ') && next !== '') break; body.push(next.slice(10)) }
        script = body.join('\n') + '\n'
        break
      }
      if (line.startsWith('        run: ')) { script = line.slice('        run: '.length) + '\n'; break }
    }
    return { name: lines[0], env, script }
  })
}

/**
 * A protected job's post-install steps in a throwaway checkout: main's judge at $RUNNER_TEMP/ci/retention.mjs (where the
 * put-back step writes it, from git), `files` in the checkout, `pnpm` a stand-in when given.
 * @returns {{ green: boolean, out: string }}
 */
function runJob(job, { files, baseline, pnpm }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'protected-run-'))), work = join(dir, 'work'), temp = join(dir, 'temp'), bin = join(dir, 'bin')
  try {
    for (const folder of [work, join(temp, 'ci'), bin]) mkdirSync(folder, { recursive: true })
    writeFileSync(join(temp, 'ci/retention.mjs'), readFileSync(JUDGE))
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text) }
    // The runner's checkout is a git work tree (actions/checkout); the judge reads its state from git.
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: work }).status, 0)
    if (pnpm) writeFileSync(join(bin, 'pnpm'), pnpm, { mode: 0o755 })
    const fill = value => value.replace(/\$\{\{ needs\.baseline\.outputs\.([a-z]+) \}\}/g, (_match, suite) => packNames(baseline[suite] ?? []))
    const base = { ...process.env, RUNNER_TEMP: temp, MESSAGES_FILES, CONFIG_PATHS, PATH: `${bin}:${process.env.PATH}` }
    delete base.NODE_TEST_CONTEXT
    delete base.GITHUB_STEP_SUMMARY
    let out = ''
    for (const step of stepsAfterInstall(job)) {
      const env = { ...base, ...Object.fromEntries(Object.entries(step.env).map(([name, value]) => [name, fill(value)])) }
      const ran = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.script], { cwd: work, env, encoding: 'utf8' })
      out += `[${step.name}] exit ${ran.status}\n${ran.stdout}${ran.stderr}`
      if (ran.status !== 0) return { green: false, out }
    }
    return { green: true, out }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const RELAY_TEST = 'deploy/cloudflare/src/__tests__/crew-relay.test.mjs'
const WORKER_NAME = 'real Worker and HeadDO persist honest local channels and idempotent unsigned turns'
/** Main's edge suite in small: a protected relay test that imports the OPEN relay tool, and the Messages files. */
const edgeFiles = tool => ({
  'deploy/cloudflare/src/crew-relay-tool.mjs': tool,
  [RELAY_TEST]: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { relay } from '../crew-relay-tool.mjs'\ntest('relay answers', () => { assert.equal(relay(), 'ok') })\n",
  'deploy/cloudflare/src/__tests__/worker.spec.ts': `import test from 'node:test'\ntest('${WORKER_NAME}', () => {})\ntest('another worker case', () => {})\n`,
  'server/preflight-ordering.test.mjs': "import test from 'node:test'\ntest('Round26 approval holds', () => {})\n",
})
const EDGE_BASELINE = { edge: [`${RELAY_TEST}::relay answers`], messages: [`deploy/cloudflare/src/__tests__/worker.spec.ts::${WORKER_NAME}`, 'server/preflight-ordering.test.mjs::Round26 approval holds'] }
/** Her open tool, changed: it rewrites the judge where the protected job keeps it, and it is broken. */
const REWRITER = "import { writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\n"
  + "writeFileSync(join(process.env.RUNNER_TEMP, 'ci', 'retention.mjs'), 'process.exit(0)\\n')\nexport const relay = () => 'broken'\n"

test('the edge job is red when her open file rewrites the judge in RUNNER_TEMP and breaks main\'s relay test', () => {
  const honest = runJob('edge', { files: edgeFiles("export const relay = () => 'ok'\n"), baseline: EDGE_BASELINE })
  assert.equal(honest.green, true, honest.out)
  const broken = runJob('edge', { files: edgeFiles(REWRITER), baseline: EDGE_BASELINE })
  assert.equal(broken.green, false, `a protected test is broken and the judge was rewritten, yet the job was green:\n${broken.out}`)
  assert.match(broken.out, /retention edge: 1 test\(s\) that passed on main did not pass here: deploy\/cloudflare\/src\/__tests__\/crew-relay\.test\.mjs::relay answers/)
  assert.match(broken.out, /a test changed the judge \(retention\.mjs\) while the suites ran/)
})

test('the edge job is red when her open file rewrites the judge even though every test passes', () => {
  const quiet = "import { appendFileSync } from 'node:fs'\nimport { join } from 'node:path'\n"
    + "appendFileSync(join(process.env.RUNNER_TEMP, 'ci', 'retention.mjs'), '\\n// rewritten\\n')\nexport const relay = () => 'ok'\n"
  const run = runJob('edge', { files: edgeFiles(quiet), baseline: EDGE_BASELINE })
  assert.equal(run.green, false, run.out)
  assert.match(run.out, /a test changed the judge \(retention\.mjs\) while the suites ran/)
})

/** A stand-in vitest: it runs "her module" (rewrites the judge) and writes the JSON results where it is told. */
const fakeVitest = (status, exit, file, rewrite) => '#!/bin/sh\n'
  + (rewrite ? 'printf "process.exit(0)\\n" > "$RUNNER_TEMP/ci/retention.mjs"\n' : '')
  + 'for arg in "$@"; do case "$arg" in --outputFile.json=*) out="${arg#--outputFile.json=}";; esac; done\n'
  + `printf '{"testResults":[{"name":"%s/${file}","status":"${status}","assertionResults":[{"fullName":"card shows","status":"${status}"}]}]}' "$PWD" > "$out"\nexit ${exit}\n`

test('the ui and boot jobs are red when the code their suite runs rewrites the judge and a test of main fails', () => {
  for (const [job, file] of [['ui', 'packages/client/ui-layout/tests/card.client.spec.tsx'], ['boot', 'packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts']]) {
    const baseline = { [job]: [`${file}::card shows`] }
    // The job's suite folder holds main's spec (what the put-back step restored, and what the judge holds).
    const files = { [file]: "it('card shows', () => {})\n" }
    const honest = runJob(job, { files, baseline, pnpm: fakeVitest('passed', 0, file, false) })
    assert.equal(honest.green, true, `${job}: ${honest.out}`)
    const broken = runJob(job, { files, baseline, pnpm: fakeVitest('failed', 1, file, true) })
    assert.equal(broken.green, false, `${job}: a test of main failed and the judge was rewritten, yet the job was green:\n${broken.out}`)
    assert.match(broken.out, /a test changed the judge \(retention\.mjs\) while the suites ran/, job)
  }
})

/** Review, MUST 1, his example: her open relay tool (its exports kept) rewrites main's Round26 file, which the
 * Messages run of the same job runs next, into tests of the same names with no assertions. */
const ROUND26 = 'server/preflight-ordering.test.mjs'
const HIS_REWRITE = "import { readFileSync, writeFileSync } from 'node:fs'\n"
  + `const p = '${ROUND26}'\n`
  + "const names = [...readFileSync(p, 'utf8').matchAll(/^test\\('([^']+)'/gm)].map(m => m[1])\n"
  + "writeFileSync(p, \"import test from 'node:test'\\n\" + names.map(n => 'test(' + JSON.stringify(n) + ',()=>{})').join('\\n'))\n"
const round26Files = tool => ({ ...edgeFiles(tool),
  [ROUND26]: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { approval } from '../deploy/cloudflare/src/crew-relay-tool.mjs'\n"
    + "test('Round26 approval holds', () => { assert.equal(approval, 'held') })\n" })

test('his example ends red: the edge run rewrites main\'s Round26 file before the Messages run, and the judge names it', () => {
  const honest = runJob('edge', { files: round26Files("export const relay = () => 'ok'\nexport const approval = 'held'\n"), baseline: EDGE_BASELINE })
  assert.equal(honest.green, true, honest.out)
  // Her tool breaks the approval Round26 checks, and rewrites Round26 so its names pass without their assertions.
  const run = runJob('edge', { files: round26Files(HIS_REWRITE + "export const relay = () => 'ok'\nexport const approval = 'broken'\n"), baseline: EDGE_BASELINE })
  assert.equal(run.green, false, `the Round26 file was rewritten between the two runs, yet the job was green:\n${run.out}`)
  assert.match(run.out, /a test changed server\/preflight-ordering\.test\.mjs \(put back from main for this job\) before the messages run; nothing is decided from this run/)
  assert.doesNotMatch(run.out, /retention messages: all/, 'the Messages run never started')
  // The same rewrite of a held file inside one run (the edge run rewrites another edge test after it ran) is red before the answer.
  const late = "import { appendFileSync } from 'node:fs'\nappendFileSync('deploy/cloudflare/src/__tests__/worker.spec.ts', '\\n// rewritten\\n')\nexport const relay = () => 'ok'\n"
  const inRun = runJob('edge', { files: edgeFiles(late), baseline: EDGE_BASELINE })
  assert.equal(inRun.green, false, inRun.out)
  assert.match(inRun.out, /a test changed deploy\/cloudflare\/src\/__tests__\/worker\.spec\.ts \(put back from main for this job\) before the messages run/)
})

test('the edge run cannot prepare the ground for the Messages run outside the held files either: an open file rewritten, or a package planted beside a held test, ends red, named', () => {
  // Her open tool breaks the approval Round26 checks; when the edge run imports it, it rewrites itself to harmless bytes.
  const harmless = "export const relay = () => 'ok'\nexport const approval = 'held'\n"
  const selfRewrite = "import { writeFileSync } from 'node:fs'\n"
    + `writeFileSync('deploy/cloudflare/src/crew-relay-tool.mjs', ${JSON.stringify(harmless)})\n`
    + "export const relay = () => 'ok'\nexport const approval = 'broken'\n"
  const rewritten = runJob('edge', { files: round26Files(selfRewrite), baseline: EDGE_BASELINE })
  assert.equal(rewritten.green, false, `the open file the Messages run imports was rewritten during the edge run, yet the job was green:\n${rewritten.out}`)
  assert.match(rewritten.out, /a test changed deploy\/cloudflare\/src\/crew-relay-tool\.mjs \(in the checkout\) before the messages run; nothing is decided from this run/)
  assert.doesNotMatch(rewritten.out, /retention messages: all/, 'the Messages run never started')
  // A package planted in a node_modules folder beside a held test (ignored by git, as on the runner): red, named.
  const plant = "import { mkdirSync, writeFileSync } from 'node:fs'\nmkdirSync('server/node_modules/dep', { recursive: true })\n"
    + "writeFileSync('server/node_modules/dep/index.js', 'export const approval = \"held\"\\n')\nexport const relay = () => 'ok'\nexport const approval = 'held'\n"
  const planted = runJob('edge', { files: { ...round26Files(plant), '.gitignore': 'node_modules\n' }, baseline: EDGE_BASELINE })
  assert.equal(planted.green, false, planted.out)
  assert.match(planted.out, /a test changed server\/node_modules \(in the checkout\) before the messages run/)
})
