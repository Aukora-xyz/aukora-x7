// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/retention.test.mjs  (builds throwaway folders and git repositories in the OS temp folder; no network)
//
// Retention by name (MUST 4b): a pass is counted by the names that passed on main, never by an exit code. And the
// protected jobs of .github/workflows/proposal-checks.yml put main's tests back before anything of the proposal runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADDED_TEST_RULE, PACKED_NAMES_MAX_BYTES, VITEST_EXACT_RUNNER, addedRun, addedVerdict, baselineVerdict, duplicateNames, holdFiles, main, nodeResults, packNames, protectedRun, protectedRunArguments, retentionVerdict, unpackNames, vitestResults } from './retention.mjs'

// Review (SHOULD): the in-process judge calls below must not append fixture verdicts to the summary of the job
// that runs this file (deploy-x61.yml and proposal-gate.yml run deploy/ci/*.test.mjs on GitHub).
delete process.env.GITHUB_STEP_SUMMARY

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const JUDGE = fileURLToPath(new URL('./retention.mjs', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/proposal-checks.yml'), 'utf8')
const passed = name => ({ status: 'passed', name })

test('identical lists pass; one added test passes', () => {
  const names = ['a.test.mjs::one', 'a.test.mjs::two', 'b.test.mjs::parent > child']
  assert.deepEqual(retentionVerdict(names, names.map(passed), 0), { ok: true, missing: [] })
  assert.equal(retentionVerdict(names, [...names, 'a.test.mjs::three'].map(passed), 0).ok, true)
})

test('a suite that exits 0 after running nothing fails; so does one that ran only part', () => {
  const names = ['a.test.mjs::one', 'a.test.mjs::two']
  const nothing = retentionVerdict(names, [], 0)
  assert.equal(nothing.ok, false); assert.deepEqual(nothing.missing, names)
  const part = retentionVerdict(names, [passed('a.test.mjs::one')], 0)
  assert.equal(part.ok, false); assert.deepEqual(part.missing, ['a.test.mjs::two'])
})

test('one renamed test fails; a skipped or failed one is not passed; duplicates count', () => {
  const names = ['a.test.mjs::one', 'a.test.mjs::two']
  assert.deepEqual(retentionVerdict(names, [passed('a.test.mjs::one'), passed('a.test.mjs::two (renamed)')], 0).missing, ['a.test.mjs::two'])
  assert.equal(retentionVerdict(names, [passed('a.test.mjs::one'), { status: 'skipped', name: 'a.test.mjs::two' }], 0).ok, false)
  assert.equal(retentionVerdict(names, [passed('a.test.mjs::one'), { status: 'failed', name: 'a.test.mjs::two' }], 0).ok, false)
  // Two tests of one name on main need two passes here.
  assert.deepEqual(retentionVerdict(['x::same', 'x::same'], [passed('x::same')], 0).missing, ['x::same'])
})

test('every name kept but a non-zero exit still fails; an empty baseline never passes anything', () => {
  assert.equal(retentionVerdict(['a::one'], [passed('a::one')], 1).ok, false)
  assert.equal(retentionVerdict([], [passed('a::one')], 0).ok, false)
})

test("main's own baseline must be green: red names are named, a run of nothing fails", () => {
  const red = baselineVerdict([passed('a::one'), { status: 'failed', name: 'a::B3 case' }], 1)
  assert.equal(red.ok, false); assert.equal(red.reason, "main's own baseline is red: a::B3 case")
  assert.equal(baselineVerdict([], 0).ok, false)
  assert.equal(baselineVerdict([passed('a::one')], 1).ok, false)
  assert.deepEqual(baselineVerdict([passed('b::two'), passed('a::one'), { status: 'skipped', name: 'c' }], 0), { ok: true, red: [], passed: ['a::one', 'b::two'] })
  assert.deepEqual(unpackNames(packNames(['a::one', 'b::two'])), ['a::one', 'b::two'])
})

test('vitest JSON: names are file::fullName relative to the checkout', () => {
  const json = JSON.stringify({ testResults: [{ name: '/w/packages/x/tests/a.spec.ts', assertionResults: [{ fullName: 'card > shows', status: 'passed' }, { fullName: 'card > hides', status: 'failed' }] }] })
  assert.deepEqual(vitestResults(json, '/w'), [{ status: 'passed', name: 'packages/x/tests/a.spec.ts::card > shows' }, { status: 'failed', name: 'packages/x/tests/a.spec.ts::card > hides' }])
  assert.throws(() => vitestResults('{}', '/w'), /RETENTION_JSON_INVALID/)
})

// A runner started inside a test run must not report to this one (node sets NODE_TEST_CONTEXT for its children).
const childEnv = { ...process.env }
delete childEnv.NODE_TEST_CONTEXT

/** A throwaway folder with node test files; `run` runs node --test with main's reporter and returns the CLI's verdict. */
function suite(files) {
  const dir = mkdtempSync(join(tmpdir(), 'retention-'))
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text) }
  const run = () => {
    const out = join(dir, 'out.jsonl')
    rmSync(out, { force: true })
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${JUDGE}`, `--test-reporter-destination=${out}`,
      ...Object.keys(files).filter(path => path.endsWith('.test.mjs'))], { cwd: dir, encoding: 'utf8', env: childEnv })
    return { exit: result.status, out }
  }
  return { dir, run, write: (path, text) => writeFileSync(join(dir, path), text), remove: () => rmSync(dir, { recursive: true, force: true }) }
}

test('end to end: main\'s reporter and CLI fail a run whose product code ends the process early with exit 0', () => {
  const box = suite({
    'product.mjs': 'export const value = 1\n',
    'a.test.mjs': "import test from 'node:test'\nimport { value } from './product.mjs'\ntest('one', () => {})\ntest('two', () => { if (value !== 1) throw new Error('x') })\ntest('nested', async t => { await t.test('inner', () => {}) })\n",
  })
  try {
    const lines = []
    const first = box.run()
    assert.equal(first.exit, 0)
    assert.equal(main(['baseline', '--suite', 'edge', '--node', first.out, '--root', box.dir, '--exit', String(first.exit)], line => lines.push(line)), 0)
    const packed = lines.at(-1)
    assert.deepEqual(unpackNames(packed), ['a.test.mjs::nested', 'a.test.mjs::nested > inner', 'a.test.mjs::one', 'a.test.mjs::two'])
    assert.deepEqual(nodeResults(readFileSync(first.out, 'utf8'), box.dir).map(result => result.status), ['passed', 'passed', 'passed', 'passed'])
    // Unchanged: the proposal's run keeps every name.
    assert.equal(main(['compare', '--suite', 'edge', '--baseline', packed, '--node', first.out, '--root', box.dir, '--exit', '0'], () => {}), 0)
    // The proposal's product code exits 0 as soon as it is imported: the runner says 0, the names say no.
    box.write('product.mjs', 'export const value = 1\nprocess.exit(0)\n')
    const second = box.run(), printed = []
    assert.equal(second.exit, 0, 'the exit code alone would have passed')
    assert.equal(main(['compare', '--suite', 'edge', '--baseline', packed, '--node', second.out, '--root', box.dir, '--exit', String(second.exit)], line => printed.push(line)), 1)
    assert.match(printed[0], /^::error::retention edge: 4 test\(s\) that passed on main did not pass here/)
    assert.ok(printed.includes('missing: a.test.mjs::one'))
    // A run that wrote no results at all is a failure, not a pass.
    assert.equal(main(['compare', '--suite', 'edge', '--baseline', packed, '--node', join(box.dir, 'absent.jsonl'), '--root', box.dir, '--exit', '0'], () => {}), 1)
  } finally { box.remove() }
})

/** The `run: |` script of the first step of this name inside one job, dedented. */
function jobStep(job, name) {
  const lines = WORKFLOW.split('\n'), start = lines.indexOf(`  ${job}:`)
  const at = lines.findIndex((line, index) => index > start && line === `      - name: ${name}`)
  assert.ok(start > 0 && at > start, `${job} ${name}`)
  const env = {}, run = lines.findIndex((line, index) => index > at && line === '        run: |')
  for (const line of lines.slice(at + 1, run)) { const match = /^ {10}([A-Z_]+): (.+)$/.exec(line); if (match) env[match[1]] = match[2] }
  const body = []
  for (const line of lines.slice(run + 1)) { if (!line.startsWith('          ')) break; body.push(line.slice(10)) }
  return { script: body.join('\n') + '\n', env }
}

test("the edge job puts main's tests and configuration back: an added test, an added package.json and an edited test are gone", () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-repo-')), work = join(dir, 'work'), temp = join(dir, 'temp')
  mkdirSync(work); mkdirSync(temp)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', RUNNER_TEMP: temp }
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' })
  const put = (path, text) => { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text) }
  try {
    git('init', '-q', '-b', 'main')
    put('deploy/ci/retention.mjs', 'main judge\n'); put('deploy/cloudflare/src/__tests__/old.test.mjs', 'old\n'); put('package.json', '{"main":true}\n'); put('vitest.config.ts', 'main\n')
    // Main's judge, which the step reads to remove every added test file.
    put('deploy/ci/frozen-paths.mjs', readFileSync(join(ROOT, 'deploy/ci/frozen-paths.mjs'), 'utf8'))
    git('add', '-A'); git('commit', '-q', '-m', 'main')
    const mainSha = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', '-b', 'auma/proposal/fixture')
    // What a hostile shortcut would try (the edge and the fence refuse these too; this is the third wall).
    put('deploy/cloudflare/src/__tests__/zz-new.test.mjs', "import { writeFileSync } from 'node:fs'\nwriteFileSync('vitest.config.ts', 'process.exit(0)')\n")
    put('deploy/cloudflare/src/__tests__/package.json', '{"name":"@simplewebauthn/server"}\n'); put('deploy/cloudflare/src/__tests__/old.test.mjs', 'weaker\n')
    put('deploy/ci/retention.mjs', 'her judge\n'); put('package.json', '{"main":false}\n'); put('vitest.config.ts', 'hers\n'); put('deploy/cloudflare/src/product.mjs', 'hers\n')
    git('add', '-A'); git('commit', '-q', '-m', 'proposal')
    const { script, env: stepEnv } = jobStep('edge', "Main's tests and configuration put back")
    const configPaths = /CONFIG_PATHS: >-\n((?: {4}.+\n)+)/.exec(WORKFLOW)[1].split(/\s+/).filter(Boolean).join(' ')
    const result = spawnSync('bash', ['-c', script], { cwd: work, encoding: 'utf8', env: { ...env, MAIN_SHA: mainSha, SUITE_PATHS: stepEnv.SUITE_PATHS, CONFIG_PATHS: configPaths } })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readdirSync(join(work, 'deploy/cloudflare/src/__tests__')), ['old.test.mjs'])
    assert.equal(readFileSync(join(work, 'deploy/cloudflare/src/__tests__/old.test.mjs'), 'utf8'), 'old\n')
    assert.equal(readFileSync(join(work, 'package.json'), 'utf8'), '{"main":true}\n')
    assert.equal(readFileSync(join(work, 'vitest.config.ts'), 'utf8'), 'main\n')
    assert.equal(readFileSync(join(temp, 'ci/retention.mjs'), 'utf8'), 'main judge\n')
    // Her product code stays: it is what the suite tests.
    assert.equal(existsSync(join(work, 'deploy/cloudflare/src/product.mjs')), true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/** A runner temp folder with main's judge in it, and a GITHUB_OUTPUT file. */
function runnerTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'retention-runner-')), temp = join(dir, 'temp'), work = join(dir, 'work')
  mkdirSync(join(temp, 'ci'), { recursive: true }); mkdirSync(work)
  writeFileSync(join(temp, 'ci/retention.mjs'), readFileSync(JUDGE))
  const output = join(dir, 'github-output'); writeFileSync(output, '')
  return { dir, temp, work, output, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
/** The runner's default shell for `run:` (bash --noprofile --norc -eo pipefail {0}). */
const runnerBash = (script, options) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { encoding: 'utf8', ...options })

test("under the runner's bash -e, a red baseline still names its red tests and writes red=", () => {
  const box = runnerTemp()
  try {
    const vitest = name => JSON.stringify({ testResults: [{ name: join(box.work, `packages/x/tests/${name}.spec.ts`), assertionResults: [{ fullName: `${name} works`, status: 'passed' }] }] })
    writeFileSync(join(box.temp, 'edge.jsonl'), [{ status: 'passed', file: join(box.work, 'deploy/a.test.mjs'), name: 'one' },
      { status: 'failed', file: join(box.work, 'deploy/a.test.mjs'), name: 'B3 case' }].map(line => JSON.stringify(line)).join('\n') + '\n')
    writeFileSync(join(box.temp, 'edge.exit'), '1\n')
    writeFileSync(join(box.temp, 'messages.jsonl'), JSON.stringify({ status: 'passed', file: join(box.work, 'server/round26.test.mjs'), name: 'Round26 x' }) + '\n')
    writeFileSync(join(box.temp, 'messages.exit'), '0\n')
    writeFileSync(join(box.temp, 'ui.json'), vitest('ui')); writeFileSync(join(box.temp, 'ui.exit'), '0\n')
    writeFileSync(join(box.temp, 'boot.json'), vitest('boot')); writeFileSync(join(box.temp, 'boot.exit'), '0\n')
    const { script } = jobStep('baseline', "Baseline verdict (main's own suites must be green)")
    const result = runnerBash(script, { cwd: box.work, env: { ...process.env, RUNNER_TEMP: box.temp, GITHUB_OUTPUT: box.output } })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /::error::retention edge: main's own baseline is red: deploy\/a\.test\.mjs::B3 case/)
    const written = readFileSync(box.output, 'utf8')
    assert.match(written, /^red=.*deploy\/a\.test\.mjs::B3 case/m)
    // The green suites are still judged and kept after the red one.
    assert.deepEqual(unpackNames(/^ui=(.+)$/m.exec(written)[1]), ['packages/x/tests/ui.spec.ts::ui works'])
    assert.deepEqual(unpackNames(/^messages=(.+)$/m.exec(written)[1]), ['server/round26.test.mjs::Round26 x'])
    assert.deepEqual(unpackNames(/^boot=(.+)$/m.exec(written)[1]), ['packages/x/tests/boot.spec.ts::boot works'])
  } finally { box.remove() }
})

test('`checks` reads each job\'s result only, and the baseline names never ride on a command line', () => {
  const checks = WORKFLOW.split('\n  checks:\n')[1]
  assert.doesNotMatch(checks.replace(/#[^\n]*/g, ''), /toJSON|outputs\.(?!red\b)/)
  const { script, env } = jobStep('checks', 'Every job green')
  assert.deepEqual(env, { FENCE: '${{ needs.fence.result }}', BASELINE: '${{ needs.baseline.result }}', EDGE: '${{ needs.edge.result }}', UI: '${{ needs.ui.result }}',
    BOOT: '${{ needs.boot.result }}', NEW_NODE_TESTS: "${{ needs['new-node-tests'].result }}", NEW_VITEST_TESTS: "${{ needs['new-vitest-tests'].result }}",
    RED: '${{ needs.baseline.outputs.red }}' })
  const all = { FENCE: 'success', BASELINE: 'success', EDGE: 'success', UI: 'success', BOOT: 'success', NEW_NODE_TESTS: 'success', NEW_VITEST_TESTS: 'success' }
  const run = extra => runnerBash(script, { env: { PATH: process.env.PATH, ...all, ...extra } })
  assert.equal(run({}).status, 0)
  const red = run({ BASELINE: 'failure', EDGE: 'skipped', UI: 'skipped', BOOT: 'skipped', RED: ' deploy/a.test.mjs::B3 case' })
  assert.equal(red.status, 1); assert.match(red.stdout, /::error::main's own baseline is red: deploy\/a\.test\.mjs::B3 case/)
  assert.equal(run({ NEW_NODE_TESTS: '' }).status, 1, 'a missing result is a failure')
  assert.equal(run({ NEW_VITEST_TESTS: 'skipped' }).status, 1, 'a skipped added-test job is a failure')
  // Each protected job hands main's packed names to main's judge by the environment, not as an argument (its one judging
  // step, protected-run,).
  for (const [suite, names] of [['edge', { BASELINE_EDGE: 'edge', BASELINE_MESSAGES: 'messages' }], ['ui', { BASELINE: 'ui' }], ['boot', { BASELINE: 'boot' }]]) {
    const job = WORKFLOW.split(`\n  ${suite}:\n`)[1].split(/\n {2}[a-z][a-z-]*:\n/)[0]
    for (const [name, output] of Object.entries(names)) {
      assert.match(job, new RegExp(`${name}: \\$\\{\\{ needs\\.baseline\\.outputs\\.${output} \\}\\}\\n`), suite)
      assert.match(job, new RegExp(`--suite ${output} --runner (?:node|vitest) --baseline-env ${name} -- `), suite)
    }
    assert.doesNotMatch(job, /"\$BASELINE/, suite)
  }
  const lines = [], packed = packNames(['a::one'])
  process.env.RETENTION_TEST_BASELINE = packed
  const box = runnerTemp()
  try {
    writeFileSync(join(box.temp, 'r.jsonl'), JSON.stringify({ status: 'passed', file: 'a', name: 'one' }) + '\n')
    assert.equal(main(['compare', '--suite', 'edge', '--baseline-env', 'RETENTION_TEST_BASELINE', '--node', join(box.temp, 'r.jsonl'), '--root', box.work, '--exit', '0'], line => lines.push(line)), 0)
    assert.equal(main(['compare', '--suite', 'edge', '--baseline-env', 'RETENTION_TEST_ABSENT', '--node', join(box.temp, 'r.jsonl'), '--root', box.work, '--exit', '0'], () => {}), 1)
    assert.equal(main(['compare', '--suite', 'edge', '--baseline-env', 'lower', '--node', join(box.temp, 'r.jsonl'), '--root', box.work, '--exit', '0'], () => {}), 2)
  } finally { delete process.env.RETENTION_TEST_BASELINE; box.remove() }
})

test('Each protected job removes EVERY test file the proposal added, also one in another package that holds its filter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retention-added-')), work = join(dir, 'work'), temp = join(dir, 'temp')
  mkdirSync(work); mkdirSync(temp)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', RUNNER_TEMP: temp }
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' })
  const put = (path, text) => { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text) }
  const hostile = ['packages/client/ui-x/tests/packages/client/ui-layout/tests/z.spec.tsx', 'packages/client/ui-x/tests/packages/experimental/webworker-runtime/tests/x6/z.spec.ts',
    'packages/client/ui-layout/tests/new.client.spec.tsx', 'packages/experimental/webworker-runtime/tests/x6/new.spec.ts', 'deploy/cloudflare/src/__tests__/auma-zz-new.test.mjs']
  try {
    git('init', '-q', '-b', 'main')
    put('deploy/ci/retention.mjs', 'main judge\n'); put('deploy/ci/frozen-paths.mjs', readFileSync(join(ROOT, 'deploy/ci/frozen-paths.mjs'), 'utf8'))
    put('packages/client/ui-layout/tests/old.client.spec.tsx', 'old\n'); put('packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts', 'old\n')
    put('deploy/cloudflare/src/__tests__/old.test.mjs', 'old\n'); put('packages/client/ui-x/src/x.ts', 'old\n')
    git('add', '-A'); git('commit', '-q', '-m', 'main')
    const mainSha = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', '-b', 'auma/proposal/fixture')
    for (const path of hostile) put(path, 'process.exit(0)\n')
    put('packages/client/ui-x/src/x.ts', 'hers\n')
    git('add', '-A'); git('commit', '-q', '-m', 'proposal')
    const configPaths = /CONFIG_PATHS: >-\n((?: {4}.+\n)+)/.exec(WORKFLOW)[1].split(/\s+/).filter(Boolean).join(' ')
    for (const job of ['edge', 'ui', 'boot']) {
      git('checkout', '-q', '-f', 'auma/proposal/fixture'); git('clean', '-q', '-fdx')
      const { script, env: stepEnv } = jobStep(job, "Main's tests and configuration put back")
      const result = runnerBash(script, { cwd: work, env: { ...env, MAIN_SHA: mainSha, SUITE_PATHS: stepEnv.SUITE_PATHS, CONFIG_PATHS: configPaths } })
      assert.equal(result.status, 0, `${job}: ${result.stderr}`)
      for (const path of hostile) assert.equal(existsSync(join(work, path)), false, `${job}: ${path}`)
      assert.match(result.stdout, /added test files removed from this job: 5/, job)
      // Main's tests and her product code stay.
      assert.equal(readFileSync(join(work, 'packages/client/ui-x/src/x.ts'), 'utf8'), 'hers\n', job)
      assert.equal(existsSync(join(work, 'packages/client/ui-layout/tests/old.client.spec.tsx')), true, job)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a baseline with two tests of one identity in one file is refused, naming them', () => {
  const twice = [passed('a.test.mjs::x'), { status: 'skipped', name: 'a.test.mjs::x' }, passed('a.test.mjs::y'), passed('b.test.mjs::x')]
  assert.deepEqual(duplicateNames(twice), ['a.test.mjs::x'])
  const verdict = baselineVerdict(twice, 0)
  assert.equal(verdict.ok, false); assert.match(verdict.reason, /1 test identity\(ies\) carried by two or more tests of one file; give each its own name: a\.test\.mjs::x$/)
  // The same name in two files is two identities; nested names carry their parents.
  assert.equal(baselineVerdict([passed('a.test.mjs::x'), passed('b.test.mjs::x'), passed('a.test.mjs::p > x')], 0).ok, true)
  const lines = []
  const box = runnerTemp()
  try {
    writeFileSync(join(box.temp, 'r.jsonl'), ['one', 'one'].map(name => JSON.stringify({ status: 'passed', file: 'a.test.mjs', name })).join('\n') + '\n')
    assert.equal(main(['baseline', '--suite', 'edge', '--node', join(box.temp, 'r.jsonl'), '--root', box.work, '--exit', '0'], line => lines.push(line)), 1)
    assert.match(lines[0], /^::error::retention edge: main's own baseline has 1 test identity/)
  } finally { box.remove() }
})

test('packed names over the stated cap are refused with the job and the size, never truncated', () => {
  assert.equal(PACKED_NAMES_MAX_BYTES, 120 * 1024)
  // The outside review's probe: 5,000 SHA-labelled names pack to about 244 KB.
  const names = Array.from({ length: 5000 }, (_, index) => `deploy/a.test.mjs::case ${createHash('sha256').update(String(index)).digest('hex')}`)
  const size = Buffer.byteLength(packNames([...names].sort()))
  assert.ok(size > PACKED_NAMES_MAX_BYTES, String(size))
  const box = runnerTemp(), lines = []
  try {
    writeFileSync(join(box.temp, 'r.jsonl'), names.map(name => JSON.stringify({ status: 'passed', file: 'deploy/a.test.mjs', name: name.split('::')[1] })).join('\n') + '\n')
    assert.equal(main(['baseline', '--suite', 'edge', '--node', join(box.temp, 'r.jsonl'), '--root', box.work, '--exit', '0'], line => lines.push(line)), 1)
    assert.equal(lines.length, 1, 'no packed list is printed at all')
    assert.equal(lines[0], `::error::retention edge: the packed passed names of job edge are ${size} bytes, over the cap of ${PACKED_NAMES_MAX_BYTES} bytes; they are not truncated: split the suite or carry the names another way`)
    // A compare handed an over-cap list refuses the same way.
    const printed = []
    assert.equal(main(['compare', '--suite', 'ui', '--baseline', packNames(names), '--node', join(box.temp, 'r.jsonl'), '--root', box.work, '--exit', '0'], line => printed.push(line)), 1)
    assert.match(printed[0], /^::error::retention ui: the packed passed names of job ui are \d+ bytes, over the cap/)
  } finally { box.remove() }
})

test('the verdict for added files reads the runner\'s results only: loaded, one pass, nothing failed or skipped, exit 0', () => {
  const file = 'deploy/cloudflare/src/__tests__/auma-x.test.mjs', other = 'deploy/cloudflare/src/__tests__/auma-y.test.mjs'
  const result = (name, status = 'passed', path = file) => ({ status, name: `${path}::${name}` })
  assert.deepEqual(addedVerdict([file], [result('one'), result('two')], 0), { ok: true, problems: [] })
  // A file the runner never reported (not loaded) is a failure; so is one whose only entry is the file's own result, told by
  // the field the reporter emits, whatever its name.
  assert.deepEqual(addedVerdict([file, other], [result('one')], 0).problems, [`${other}: the runner never reported this file (it was not loaded)`])
  for (const name of [file, 'auma-x.test.mjs', 'anything']) assert.deepEqual(addedVerdict([file], [{ ...result(name), fileSummary: true }], 0).problems, [`${file}: no test of this file passed`])
  // A TEST named after its file is a test: it passes the file (the name decides nothing).
  for (const name of [file, 'auma-x.test.mjs']) assert.deepEqual(addedVerdict([file], [result(name)], 0), { ok: true, problems: [] })
  // A skip, a todo or a cancel by any spelling: the reporter's status says so.
  assert.deepEqual(addedVerdict([file], [result('one'), result('regression', 'skipped')], 0).problems, [`${file} :: regression: skipped (an added test may not be skipped, todo or cancelled)`])
  assert.deepEqual(addedVerdict([file], [result('one'), result('later', 'todo')], 0).problems, [`${file} :: later: todo (an added test may not be skipped, todo or cancelled)`])
  assert.deepEqual(addedVerdict([file], [result('one'), result('two', 'failed')], 1).problems, [`${file} :: two: failed`])
  assert.deepEqual(addedVerdict([file], [{ ...result('auma-x.test.mjs', 'failed'), fileSummary: true }], 1).problems, [`${file} (the file itself): failed`, `${file}: no test of this file passed`])
  // A describe() suite is not a test: its pass alone is not one.
  assert.deepEqual(addedVerdict([file], [{ ...result('suite'), suite: true }], 0).problems, [`${file}: no test of this file passed`])
  // A result for a file the inventory does not name; and a clean run that exited non-zero.
  assert.deepEqual(addedVerdict([file], [result('one'), result('x', 'passed', 'elsewhere.test.mjs')], 0).problems, ['elsewhere.test.mjs::x: reported for a file the proposal did not add'])
  assert.equal(addedVerdict([file], [result('one')], 1).reason, 'every added test passed, but the run exited 1')
  assert.equal(ADDED_TEST_RULE, 'An added test file passes only when the runner loaded it, at least one of its tests passed, none failed, none was skipped, todo or cancelled, and the runner exited 0.')
})

/**
 * A fixture repository for the added-tests jobs: main has the judges, a test configuration and a UI test; the proposal adds
 * `added` (path -> text). `job(name)` runs that job as GitHub does: a fresh checkout, its setup step, then its one judging
 * step (main's retention.mjs read from git, added-run), with RUNNER_TEMP outside the checkout.
 */
function addedFixture(added, { main: mainFiles = {} } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'retention-added-run-'))), work = join(dir, 'work')
  mkdirSync(work)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  delete env.NODE_TEST_CONTEXT
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' })
  const put = (path, text) => { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text) }
  git('init', '-q', '-b', 'main')
  put('deploy/ci/retention.mjs', readFileSync(JUDGE, 'utf8')); put('deploy/ci/frozen-paths.mjs', readFileSync(join(ROOT, 'deploy/ci/frozen-paths.mjs'), 'utf8'))
  put('vitest.config.ts', 'export default {}\n'); put('packages/client/ui-layout/tests/old.client.spec.tsx', 'old\n'); put('packages/client/ui-layout/tests/helper.ts', 'main helper\n')
  put('deploy/cloudflare/src/__tests__/old.test.mjs', 'old\n')
  for (const [path, text] of Object.entries(mainFiles)) put(path, text)
  git('add', '-A'); git('commit', '-q', '-m', 'main')
  const mainSha = git('rev-parse', 'HEAD').trim()
  git('checkout', '-q', '-b', 'auma/proposal/fixture')
  for (const [path, text] of Object.entries(added)) put(path, text)
  if (Object.keys(added).length) { git('add', '-A'); git('commit', '-q', '-m', 'proposal') } else git('commit', '-q', '--allow-empty', '-m', 'proposal')
  const configPaths = /CONFIG_PATHS: >-\n((?: {4}.+\n)+)/.exec(WORKFLOW)[1].split(/\s+/).filter(Boolean).join(' ')
  const job = (name, fake) => {
    git('checkout', '-q', '-f', 'auma/proposal/fixture'); git('clean', '-q', '-fdx')
    const temp = mkdtempSync(join(dir, `${name}-temp-`)), bin = join(dir, `${name}-bin`), summary = join(temp, 'summary.md')
    rmSync(bin, { recursive: true, force: true }); mkdirSync(bin, { recursive: true })
    // A stand-in vitest (`fakeVitest`): the package the judge's exact runner loads from the checkout, and a `pnpm` for a
    // judge that would call vitest's command line instead; both select by vitest's own substring rule.
    if (fake) {
      writeFileSync(join(bin, 'pnpm'), fake.pnpm, { mode: 0o755 })
      put('node_modules/vitest/package.json', JSON.stringify({ name: 'vitest', type: 'module', exports: { './node': './node.js' } })); put('node_modules/vitest/node.js', fake.vitest)
    }
    const stepEnv = { ...env, RUNNER_TEMP: temp, MAIN_SHA: mainSha, CONFIG_PATHS: configPaths, PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary }
    const setup = jobStep(name, "Main's configuration, setup and helpers put back; the judge outside the checkout")
    const ran = [runnerBash(setup.script, { cwd: work, env: { ...stepEnv, ...setup.env, MAIN_SHA: mainSha } })]
    const kind = name === 'new-node-tests' ? 'node' : 'vitest'
    const line = WORKFLOW.split(`\n  ${name}:\n`)[1].split(`      - name: Her new ${kind} tests, judged in one process by main's retention.mjs\n`)[1].split('\n').find(text => text.startsWith('        run: ')).replace(/^ {8}run: /, '')
    ran.push(runnerBash(line, { cwd: work, env: stepEnv }))
    return { ran, temp, out: ran[1].stdout + ran[1].stderr, summary: () => existsSync(summary) ? readFileSync(summary, 'utf8') : '', read: path => readFileSync(join(work, path), 'utf8') }
  }
  return { job, work, mainSha, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
const HER = 'deploy/cloudflare/src/__tests__/auma-shortcut.test.mjs'

test('the outside review\'s auma-shortcut.test.mjs is red: emptying a list file in RUNNER_TEMP changes nothing, the judge read the inventory from git', () => {
  const fx = addedFixture({ [HER]: "import test from 'node:test'\nimport { writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\n"
    + "writeFileSync(join(process.env.RUNNER_TEMP, 'added.list'), '')\ntest.skip('regression', () => { throw new Error('must fail') })\n" })
  try {
    const { ran, out, temp, summary } = fx.job('new-node-tests')
    assert.equal(ran[0].status, 0, ran[0].stderr)
    assert.equal(existsSync(join(temp, 'added.list')), true, 'the test did write its list file: nothing reads it')
    assert.equal(ran[1].status, 1, out)
    assert.match(out, /problem: deploy\/cloudflare\/src\/__tests__\/auma-shortcut\.test\.mjs :: regression: skipped/)
    assert.match(out, /problem: deploy\/cloudflare\/src\/__tests__\/auma-shortcut\.test\.mjs: no test of this file passed/)
    assert.doesNotMatch(out, /adds no test file/)
    assert.ok(out.includes(ADDED_TEST_RULE)); assert.ok(summary().includes(ADDED_TEST_RULE), 'the rule is in the job summary')
  } finally { fx.remove() }
})

test('a test that rewrites retention.mjs in the checkout changes nothing; one that rewrites the judge outside it, or its own source after collection, is red', () => {
  const green = "export default async function * () {}\nexport function main () { return 0 }\nexport const addedRun = async () => 0\n"
  const fx = addedFixture({ [HER]: "import test from 'node:test'\nimport { writeFileSync } from 'node:fs'\n"
    + `writeFileSync('deploy/ci/retention.mjs', ${JSON.stringify(green)})\ntest('regression', () => { throw new Error('must fail') })\n` })
  try {
    const { ran, out, read } = fx.job('new-node-tests')
    assert.equal(read('deploy/ci/retention.mjs'), green, 'the checkout\'s judge was rewritten')
    assert.equal(ran[1].status, 1, out); assert.match(out, /auma-shortcut\.test\.mjs :: regression: failed/)
  } finally { fx.remove() }
  const judge = addedFixture({ [HER]: "import test from 'node:test'\nimport { appendFileSync } from 'node:fs'\nimport { join } from 'node:path'\n"
    + "appendFileSync(join(process.env.RUNNER_TEMP, 'ci', 'retention.mjs'), '\\n// rewritten')\ntest('one', () => {})\n" })
  try {
    const { ran, out } = judge.job('new-node-tests')
    assert.equal(ran[1].status, 1, out); assert.match(out, /an added test changed a file the verdict reads \(.*retention\.mjs\)/)
  } finally { judge.remove() }
  const self = addedFixture({ [HER]: "import test from 'node:test'\nimport { appendFileSync } from 'node:fs'\n"
    + `test('one', () => { appendFileSync(${JSON.stringify(HER)}, '\\ntest("added later", () => {})\\n') })\n` })
  try {
    const { ran, out } = self.job('new-node-tests')
    assert.equal(ran[1].status, 1, out); assert.match(out, /an added test changed a file the verdict reads \(deploy\/cloudflare\/src\/__tests__\/auma-shortcut\.test\.mjs\)/)
  } finally { self.remove() }
})

test('an empty inventory is decided before the run (nothing is spawned); the runner\'s exit status is part of the verdict', async () => {
  const fx = addedFixture({ 'apps/web/src/x.ts': 'export const x = 1\n' })
  try {
    const { ran, out } = fx.job('new-node-tests')
    assert.equal(ran[1].status, 0, out); assert.match(out, /retention new-node-tests: the proposal adds no test file for this runner/)
    const printed = [], fence = join(fx.work, 'deploy/ci/frozen-paths.mjs')
    assert.equal(await addedRun({ suite: 'new-node-tests', runner: 'node', fence, main: fx.mainSha, head: 'HEAD', root: fx.work, print: line => printed.push(line),
      spawn: () => assert.fail('nothing runs for an empty inventory') }), 0)
  } finally { fx.remove() }
  const passing = addedFixture({ [HER]: "import test from 'node:test'\ntest('one', () => {})\n" })
  try {
    const fence = join(passing.work, 'deploy/ci/frozen-paths.mjs'), absolute = join(passing.work, HER)
    const stdout = JSON.stringify({ status: 'passed', file: absolute, name: 'one' }) + '\n'
    for (const [status, code] of [[0, 0], [1, 1], [null, 1]]) {
      const printed = []
      assert.equal(await addedRun({ suite: 'new-node-tests', runner: 'node', fence, main: passing.mainSha, head: 'HEAD', root: passing.work, print: line => printed.push(line),
        spawn: () => ({ status, stdout }) }), code, printed.join('\n'))
    }
    // Only her runner's files: the vitest job of this proposal has nothing to run.
    assert.match(passing.job('new-vitest-tests').out, /the proposal adds no test file for this runner/)
  } finally { passing.remove() }
})

test('through the real runner: his loop with a skip is red, his alias is green, a lone skip, an import that throws and a todo are red, a regex .test( is green', () => {
  const cases = [
    ['his loop with one skip', "import test from 'node:test'\nfor (const name of ['passes', 'regression'])\n  test(name, { skip: name === 'regression' }, () => {})\n", 1, /:: regression: skipped/],
    ['his alias', "import { test as check } from 'node:test'\ncheck('one', () => {})\n", 0, /all 1 added file\(s\) loaded/],
    ['only a skipped test', "import test from 'node:test'\ntest.skip('later', () => {})\n", 1, /:: later: skipped/],
    ['a throw at import', "import test from 'node:test'\nthrow new Error('boom')\ntest('never', () => {})\n", 1, /\(the file itself\): failed/],
    ['test.todo', "import test from 'node:test'\ntest('one', () => {})\ntest.todo('later')\n", 1, /:: later: skipped/],
    ['a regex .test( and one pass', "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('one', () => { assert.ok(/^a/.test('abc')) })\n", 0, /all 1 added file\(s\) loaded/],
    ['a describe with a skipped it', "import { describe, it } from 'node:test'\ndescribe('relay tool', () => { it.skip('refuses a stranger', () => {}) })\n", 1, /:: relay tool > refuses a stranger: skipped/],
    ['an exit before any test', "process.exit(0)\n", 1, /no test of this file passed/],
  ]
  for (const [label, text, status, said] of cases) {
    const fx = addedFixture({ [HER]: text })
    try {
      const { ran, out } = fx.job('new-node-tests')
      assert.equal(ran[1].status, status, `${label}: ${out}`); assert.match(out, said, label)
    } finally { fx.remove() }
  }
  // A suite line must say suite true; nothing else rides on the field.
  assert.throws(() => nodeResults(JSON.stringify({ status: 'passed', file: 'a.test.mjs', name: 'x', suite: 'yes' }), '/w'), /RETENTION_LINE_INVALID/)
})

/**
 * A stand-in for vitest that selects as vitest does: every *.spec.ts(x) under the checkout
 * whose path holds a filter as a substring (case-insensitive). It reports each file it runs with one test, `regression`,
 * of `status` (or names `report` instead of the file), writes the JSON where it is told (unless `write` is false), prints
 * that path when `echo`, and exits `exit`. `{ vitest }` is the package the judge's exact runner loads; `{ pnpm }` is the
 * command line a judge that passes filters to `pnpm exec vitest run` would call.
 */
function fakeVitest({ status = 'passed', exit = 0, report = null, write = true, echo = false } = {}) {
  const select = `import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
const walk = dir => readdirSync(dir).flatMap(name => name === 'node_modules' || name === '.git' ? [] : statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)])
const relevant = filters => walk(process.cwd()).filter(file => /\\.spec\\.tsx?$/.test(file) && filters.some(f => relative(process.cwd(), file).toLowerCase().includes(f.toLowerCase())))
const finish = (out, files) => {
  ${echo ? "console.log('OUT=' + out)" : ''}
  ${write ? `writeFileSync(out, JSON.stringify({ testResults: files.map(file => ({ name: ${report ? `resolve(${JSON.stringify(report)})` : 'file'}, status: ${JSON.stringify(status)}, assertionResults: [{ fullName: 'regression', status: ${JSON.stringify(status)} }] })) }))` : ''}
  if (${exit}) process.exitCode = ${exit}
}
`
  return {
    vitest: select + `export async function createVitest (mode, options) {
  const specifications = { getRelevantTestSpecifications: async filters => relevant(filters).map(moduleId => ({ moduleId })) }
  return { specifications, async start (filters) { finish(options.outputFile.json, (await specifications.getRelevantTestSpecifications(filters)).map(spec => spec.moduleId)) }, async close () {} }
}
`,
    pnpm: '#!/usr/bin/env node\n' + select + `const args = process.argv.slice(2)
finish(args.find(arg => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length), relevant(args.filter(arg => !arg.startsWith('-') && !['exec', 'vitest', 'run'].includes(arg))))
`,
  }
}

test('the two-file example stays red, each runner in its own job; vitest results are read from a file the judge names, and a file it never reports is red', () => {
  const spec = 'packages/client/ui-layout/tests/new-regression.spec.ts'
  const fx = addedFixture({ 'deploy/cloudflare/src/__tests__/auma-zz-new.test.mjs': "import { writeFileSync } from 'node:fs'\nwriteFileSync('vitest.config.ts', 'process.exit(0); export default {}')\n",
    [spec]: "import { it } from 'vitest'\nit('regression', () => { throw new Error('must fail') })\n" })
  try {
    // The node job: only the node file runs. It rewrites vitest.config.ts in its own checkout and has no test: red.
    const node = fx.job('new-node-tests')
    assert.equal(node.ran[0].status, 0, node.ran[0].stderr); assert.match(node.ran[0].stdout, /added node test files: 1/)
    assert.equal(node.read('vitest.config.ts'), 'process.exit(0); export default {}', 'the writer did run in its own job')
    assert.equal(node.ran[1].status, 1, node.out); assert.match(node.out, /auma-zz-new\.test\.mjs: no test of this file passed/)
    // The vitest job, a fresh checkout with main's configuration. A runner that exits 0 and writes nothing: red.
    const quiet = fx.job('new-vitest-tests', fakeVitest({ write: false }))
    assert.equal(quiet.read('vitest.config.ts'), 'export default {}\n', "main's configuration, untouched by the node job")
    assert.equal(quiet.read('packages/client/ui-layout/tests/helper.ts'), 'main helper\n')
    assert.equal(quiet.ran[1].status, 1); assert.match(quiet.out, /the runner wrote no results/)
    const red = fx.job('new-vitest-tests', fakeVitest({ status: 'failed', exit: 1 }))
    assert.equal(red.ran[1].status, 1); assert.match(red.out, /new-regression\.spec\.ts :: regression: failed/)
    const green = fx.job('new-vitest-tests', fakeVitest())
    assert.equal(green.ran[1].status, 0, green.out)
    // vitest's skipped and todo statuses are red too; a report about another file leaves the added one unreported.
    for (const status of ['skipped', 'todo', 'pending']) assert.match(fx.job('new-vitest-tests', fakeVitest({ status })).out, new RegExp(`:: regression: ${status}`), status)
    const elsewhere = fx.job('new-vitest-tests', fakeVitest({ report: 'packages/client/ui-layout/tests/other.spec.ts' }))
    assert.equal(elsewhere.ran[1].status, 1); assert.match(elsewhere.out, /new-regression\.spec\.ts: the runner never reported this file/)
    // The judge names the results file at random, in a folder of its own outside the checkout.
    const path = fx.job('new-vitest-tests', fakeVitest({ write: false, echo: true, exit: 1 }))
    const named = /OUT=(.+)/.exec(path.out)[1]
    assert.match(named, /retention-added-[^/]+\/[0-9a-f-]{36}\.json$/); assert.equal(named.startsWith(fx.work), false)
  } finally { fx.remove() }
})

test('the added vitest files are selected EXACTLY: his identity-devices.client.spec.ts beside main\'s .tsx is green; a result from a file outside the inventory is still red', () => {
  const added = 'packages/client/ui-layout/tests/identity-devices.client.spec.ts'
  const fx = addedFixture({ [added]: "import { it } from 'vitest'\nit('one', () => {})\n" },
    { main: { 'packages/client/ui-layout/tests/identity-devices.client.spec.tsx': "import { it } from 'vitest'\nit('main case', () => {})\n" } })
  try {
    const his = fx.job('new-vitest-tests', fakeVitest())
    assert.equal(his.ran[1].status, 0, `only the added file may run, and it passed:\n${his.out}`)
    assert.match(his.out, /retention new-vitest-tests: all 1 added file\(s\) loaded/)
    assert.doesNotMatch(his.out, /identity-devices\.client\.spec\.tsx/)
    // A result the runner gives for a file the inventory does not name still fails the verdict.
    const stray = fx.job('new-vitest-tests', fakeVitest({ report: 'packages/client/ui-layout/tests/identity-devices.client.spec.tsx' }))
    assert.equal(stray.ran[1].status, 1, stray.out)
    assert.match(stray.out, /identity-devices\.client\.spec\.tsx::regression: reported for a file the proposal did not add/)
  } finally { fx.remove() }
  // The exact runner the judge gives node: vitest's own resolution and glob, then only the added files by exact path.
  assert.match(VITEST_EXACT_RUNNER, /spec => wanted\.has\(spec\.moduleId\)/)
  assert.doesNotMatch(VITEST_EXACT_RUNNER, /includes\(/)
})

test('a file\'s own result is told by the field the reporter emits, never by a name: a test named after its file passes, an empty file does not', () => {
  const cases = [
    ['his auma-one.test.mjs', 'deploy/cloudflare/src/__tests__/auma-one.test.mjs', "import test from 'node:test'\ntest('auma-one.test.mjs', () => {})\n", 0, /all 1 added file\(s\) loaded/],
    ['a test named by the whole path', 'deploy/cloudflare/src/__tests__/auma-two.test.mjs', "import test from 'node:test'\ntest('deploy/cloudflare/src/__tests__/auma-two.test.mjs', () => {})\n", 0, /all 1 added file\(s\) loaded/],
    ['an empty file (node passes the file itself)', 'deploy/cloudflare/src/__tests__/auma-empty.test.mjs', '\n', 1, /auma-empty\.test\.mjs: no test of this file passed/],
  ]
  for (const [label, path, text, status, said] of cases) {
    const fx = addedFixture({ [path]: text })
    try {
      const { ran, out } = fx.job('new-node-tests')
      assert.equal(ran[1].status, status, `${label}: ${out}`); assert.match(out, said, label)
    } finally { fx.remove() }
  }
  // Vitest: a test named after its file is a test; the file's own failure is the record this judge makes, with the field.
  const root = '/w', path = 'packages/client/ui-layout/tests/auma-one.client.spec.ts'
  const named = vitestResults(JSON.stringify({ testResults: [{ name: `${root}/${path}`, status: 'passed', assertionResults: [{ fullName: 'auma-one.client.spec.ts', status: 'passed' }] }] }), root)
  assert.deepEqual(named, [{ status: 'passed', name: `${path}::auma-one.client.spec.ts` }])
  assert.deepEqual(addedVerdict([path], named, 0), { ok: true, problems: [] })
  const threw = vitestResults(JSON.stringify({ testResults: [{ name: `${root}/${path}`, status: 'failed', assertionResults: [] }] }), root)
  assert.deepEqual(threw, [{ status: 'failed', name: `${path}::auma-one.client.spec.ts`, fileSummary: true }])
  assert.deepEqual(addedVerdict([path], threw, 1).problems, [`${path} (the file itself): failed`, `${path}: no test of this file passed`])
  // The field is exact: only `true` rides on it.
  assert.throws(() => nodeResults(JSON.stringify({ status: 'passed', file: 'a.test.mjs', name: 'x', fileSummary: 'yes' }), '/w'), /RETENTION_LINE_INVALID/)
})

test('protected-run holds main\'s names before anything runs, gives the runner its reporter from the bytes it holds, and its arguments are exact', () => {
  const edge = ['--suite', 'edge', '--runner', 'node', '--baseline-env', 'BASELINE_EDGE', '--', 'a.test.mjs', 'b.test.mjs'], hold = ['--hold', 'tests package.json  scripts']
  assert.deepEqual(protectedRunArguments(['--root', '/w', ...hold, ...edge, '--and', '--suite', 'messages', '--runner', 'node', '--baseline-env', 'BASELINE_MESSAGES', '--', '--test-name-pattern=^Round26 ', 'c.test.mjs']),
    { root: '/w', hold: ['tests', 'package.json', 'scripts'], runs: [{ suite: 'edge', runner: 'node', baselineEnv: 'BASELINE_EDGE', args: ['a.test.mjs', 'b.test.mjs'] },
      { suite: 'messages', runner: 'node', baselineEnv: 'BASELINE_MESSAGES', args: ['--test-name-pattern=^Round26 ', 'c.test.mjs'] }] })
  // Review, MUST 1: --hold is required, right after --root, and names at least one path.
  for (const argv of [[], ['--root', '/w'], ['--root', '/w', ...hold], ['--root', '/w', ...hold, ...edge, '--and'], ['--root', '/w', ...hold, '--suite', 'edge', '--runner', 'node', '--', 'a'], edge,
    ['--root', '/w', ...edge], ['--root', '/w', '--hold', ' ', ...edge], [...hold, '--root', '/w', ...edge]]) assert.equal(protectedRunArguments(argv), null, JSON.stringify(argv))
  assert.equal(main(['protected-run', '--root', '/w'], () => {}), 2)
  const runs = [{ suite: 'edge', runner: 'node', baselineEnv: 'BASELINE_EDGE', args: ['a.test.mjs'] }]
  // An empty or absent baseline is refused before anything is spawned.
  for (const env of [{}, { BASELINE_EDGE: packNames([]) }]) {
    const printed = []
    assert.equal(protectedRun({ runs, root: '/w', hold: ['a.test.mjs'], env, print: line => printed.push(line), spawn: () => assert.fail('nothing runs without main\'s names') }), 1)
    assert.match(printed[0], /edge: the baseline holds no passed test \(BASELINE_EDGE\); nothing was run/)
  }
  const over = 'x'.repeat(PACKED_NAMES_MAX_BYTES + 1), printed = []
  assert.equal(protectedRun({ runs, root: '/w', hold: ['a.test.mjs'], env: { BASELINE_EDGE: over }, print: line => printed.push(line), spawn: () => assert.fail('nothing runs') }), 1)
  assert.match(printed[0], /over the cap/)
  // Nothing held (no --hold, or it names no file the job put back): refused before anything runs.
  const w = realpathSync(mkdtempSync(join(tmpdir(), 'retention-hold-')))
  try {
    for (const [holdPaths, said] of [[undefined, /needs --hold/], [[], /needs --hold/], [['absent'], /--hold names no file the job put back; nothing was run/], [['../x'], /RETENTION_HOLD_INVALID/]]) {
      const lines = []
      assert.equal(protectedRun({ runs, root: w, hold: holdPaths, env: { BASELINE_EDGE: packNames(['a.test.mjs::one']) }, print: line => lines.push(line), spawn: () => assert.fail('nothing runs') }), 1)
      assert.match(lines.join('\n'), said)
    }
  } finally { rmSync(w, { recursive: true, force: true }) }
  // The runner gets the judge's own bytes as a data: URL reporter, and no baseline in its environment. (A checkout that
  // holds the run's file: what is held must exist.)
  const W = realpathSync(mkdtempSync(join(tmpdir(), 'retention-hold-')))
  writeFileSync(join(W, 'a.test.mjs'), 'main\'s test\n')
  // Review, SHOULD: the checkout's state is read from git; a folder that is not a work tree is refused before anything runs.
  const notGit = []
  assert.equal(protectedRun({ runs, root: W, hold: ['a.test.mjs'], env: { BASELINE_EDGE: packNames(['a.test.mjs::one']) }, print: line => notGit.push(line), spawn: () => assert.fail('nothing runs') }), 1)
  assert.match(notGit.join('\n'), /the checkout's state could not be read from git \(.+\); nothing was run/)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: W }).status, 0)
  const seen = []
  const spawn = (command, args, options) => { seen.push({ args, env: options.env }); return { status: 0, stdout: JSON.stringify({ status: 'passed', file: `${W}/a.test.mjs`, name: 'one' }) + '\n' } }
  const lines = []
  assert.equal(protectedRun({ runs, root: W, hold: ['a.test.mjs'], env: { BASELINE_EDGE: packNames(['a.test.mjs::one']), PATH: '/bin', NODE_TEST_CONTEXT: 'child-v8' }, print: line => lines.push(line), spawn }), 0, lines.join('\n'))
  assert.equal(seen[0].args[1], `--test-reporter=data:text/javascript;base64,${readFileSync(JUDGE).toString('base64')}`)
  assert.equal(Object.hasOwn(seen[0].env, 'BASELINE_EDGE'), false); assert.equal(Object.hasOwn(seen[0].env, 'NODE_TEST_CONTEXT'), false)
  assert.deepEqual(lines, ['retention edge: all 1 test(s) that passed on main passed here'])
  // A name of main that did not pass, or a red exit, is red, named.
  const red = []
  assert.equal(protectedRun({ runs, root: W, hold: ['a.test.mjs'], env: { BASELINE_EDGE: packNames(['a.test.mjs::one', 'a.test.mjs::two']) }, print: line => red.push(line), spawn }), 1)
  assert.ok(red.includes('missing: a.test.mjs::two'))
  assert.equal(protectedRun({ runs, root: W, hold: ['a.test.mjs'], env: { BASELINE_EDGE: packNames(['a.test.mjs::one']) }, print: () => {}, spawn: () => ({ status: 1, stdout: JSON.stringify({ status: 'passed', file: `${W}/a.test.mjs`, name: 'one' }) + '\n' }) }), 1)
  rmSync(W, { recursive: true, force: true })
})

test('protected-run holds every file under --hold before the first run and checks it before each later run and before answering', () => {
  const w = realpathSync(mkdtempSync(join(tmpdir(), 'retention-hold-')))
  try {
    for (const [path, text] of [['tests/a.test.mjs', 'a'], ['tests/helper.mjs', 'h'], ['tests/node_modules/x.js', 'not held'], ['round26.test.mjs', 'r'], ['package.json', '{}']]) {
      mkdirSync(dirname(join(w, path)), { recursive: true }); writeFileSync(join(w, path), text)
    }
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: w }).status, 0)
    assert.deepEqual([...holdFiles(w, ['tests', 'round26.test.mjs', 'package.json', 'absent']).keys()].sort(), ['package.json', 'round26.test.mjs', 'tests/a.test.mjs', 'tests/helper.mjs'])
    const env = { BASELINE_EDGE: packNames(['tests/a.test.mjs::one']), BASELINE_MESSAGES: packNames(['round26.test.mjs::Round26 one']) }
    const runs = [{ suite: 'edge', runner: 'node', baselineEnv: 'BASELINE_EDGE', args: ['tests/a.test.mjs'] }, { suite: 'messages', runner: 'node', baselineEnv: 'BASELINE_MESSAGES', args: ['round26.test.mjs'] }]
    const hold = ['tests', 'round26.test.mjs', 'package.json']
    const answer = { 'tests/a.test.mjs': 'one', 'round26.test.mjs': 'Round26 one' }
    // Each run answers for its file; `during` is what the run's code does to the checkout.
    const judge = during => {
      const lines = [], started = []
      const code = protectedRun({ runs, root: w, hold, env, print: line => lines.push(line), spawn: (command, args) => {
        const file = args.at(-1); started.push(file); during(file)
        return { status: 0, stdout: JSON.stringify({ status: 'passed', file: join(w, file), name: answer[file] }) + '\n' }
      } })
      return { code, lines: lines.join('\n'), started }
    }
    assert.deepEqual(judge(() => {}), { code: 0, lines: 'retention edge: all 1 test(s) that passed on main passed here\nretention messages: all 1 test(s) that passed on main passed here', started: ['tests/a.test.mjs', 'round26.test.mjs'] })
    // The edge run rewrites the Messages file: red before the Messages run starts, naming it.
    const before = judge(file => { if (file === 'tests/a.test.mjs') writeFileSync(join(w, 'round26.test.mjs'), 'vacuous') })
    assert.equal(before.code, 1); assert.deepEqual(before.started, ['tests/a.test.mjs'])
    assert.match(before.lines, /a test changed round26\.test\.mjs \(put back from main for this job\) before the messages run; nothing is decided from this run/)
    writeFileSync(join(w, 'round26.test.mjs'), 'r')
    // The last run changes a helper, or deletes one: red before the answer.
    const helper = judge(file => { if (file === 'round26.test.mjs') writeFileSync(join(w, 'tests/helper.mjs'), 'changed') })
    assert.equal(helper.code, 1); assert.match(helper.lines, /a test changed tests\/helper\.mjs \(put back from main for this job\) while the suites ran/)
    writeFileSync(join(w, 'tests/helper.mjs'), 'h')
    const gone = judge(file => { if (file === 'round26.test.mjs') rmSync(join(w, 'package.json')) })
    assert.equal(gone.code, 1); assert.match(gone.lines, /a test changed package\.json/)
    // node_modules under a held folder is not held, and a new file is not a held one; SHOULD: the rest
    // of the checkout is held too, so each is red, named (before this change both were green).
    writeFileSync(join(w, 'package.json'), '{}')
    const planted = judge(file => { if (file === 'tests/a.test.mjs') writeFileSync(join(w, 'tests/node_modules/x.js'), 'moved') })
    assert.equal(planted.code, 1); assert.deepEqual(planted.started, ['tests/a.test.mjs'])
    assert.match(planted.lines, /a test changed tests\/node_modules\/x\.js \(in the checkout\) before the messages run/)
    writeFileSync(join(w, 'tests/node_modules/x.js'), 'not held')
    const added = judge(file => { if (file === 'round26.test.mjs') writeFileSync(join(w, 'tests/new.mjs'), 'new') })
    assert.equal(added.code, 1); assert.match(added.lines, /a test changed tests\/new\.mjs \(in the checkout\) while the suites ran/)
    rmSync(join(w, 'tests/new.mjs'))
    assert.equal(judge(() => {}).code, 0)
  } finally { rmSync(w, { recursive: true, force: true }) }
})
