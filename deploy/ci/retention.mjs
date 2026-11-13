// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * RETENTION BY NAME (MUST 4b): a proposal's protected suites pass only when every test that PASSED on main also
 * passed on the proposal, counted by name. An exit code of 0 with names missing is a failure: a run that ends early, a
 * test renamed or one that stopped running cannot pass for a green.
 *
 * CI (.github/workflows/proposal-checks.yml) always runs MAIN's copy of this file, written outside the checkout before
 * anything of the proposal runs. It is two things:
 *   1. a node --test reporter (the default export): `--test-reporter=<this file> --test-reporter-destination=<file>`
 *      writes one JSON line per finished test, { status, name }, from the parent runner;
 *   2. a command line:
 *        node retention.mjs baseline --suite <name> (--node <lines> | --vitest <json>) --root <dir> --exit <code>
 *          main's own run: fails, naming them, when any test failed or nothing passed; else prints the passed names packed
 *          (gzip, base64) on one line for a job output;
 *        node retention.mjs compare --suite <name> (--baseline-env <NAME> | --baseline <packed>) (--node <lines> | --vitest <json>) --root <dir> --exit <code>
 *          the proposal's run: fails, naming them, when a name that passed on main is missing or not passed; also when the
 *          run's own exit code was not 0. CI passes the packed names in an environment variable and names it with
 *          --baseline-env, so they are not a second time on the command line.
 *        node retention.mjs added-run --suite <name> --runner node|vitest --fence <main's frozen-paths.mjs> --main <sha> --head <rev> --root <dir>
 *          the test files a proposal ADDS, judged by ONE trusted process that is the parent of the tests (MUST 2):
 *          it reads the inventory itself from `git diff <main>...<head>` with main's fence, holds every added file's bytes
 *          and sha256 in memory, decides an empty inventory BEFORE anything runs, then spawns the runner with its results
 *          on a pipe (node) or in a file it names at random (vitest; the added files are selected EXACTLY, by path, through
 *          vitest's own API, never by its substring filter; MUST 6), decides from what it holds and what it received
 *          (ADDED_TEST_RULE), and before answering hashes the added files, its own source and the fence again: a change
 *          during the run fails closed. Nothing it decides by is a file an earlier step or a test could write first.
 *          What it does NOT cover: a test that forges the runner's own event stream from inside the runner process.
 *        node retention.mjs protected-run --root <dir> --hold "<paths>" --suite <name> --runner node|vitest --baseline-env <NAME> -- <runner args>... [--and <another run>]...
 *          a protected job's suites (edge and messages, ui, boot), judged by ONE trusted process that is the parent of every
 *          run: it holds its own bytes and main's passed names (from the environment) before
 *          anything runs, loads its reporter from the bytes it holds (a data: URL), takes each run's results on a pipe it
 *          owns (node) or in a file it names at random (vitest), judges each run by name like `compare`, and before answering
 *          hashes its own source again: a test that rewrote it fails the job. No results file, exit file or judge is left
 *          for a later step to read, because there is no later step. --hold names the paths the job put back from main
 *          (its tests, helpers and configuration; MUST 1): every file under them is hashed before the
 *          first run and checked again before each later run and before answering, so one run cannot prepare the next
 *          (fails closed, naming the file).
 * A baseline with two tests of one identity (file and full name) in one file is refused, naming them (SHOULD 1);
 * packed names over PACKED_NAMES_MAX_BYTES are refused, never truncated (SHOULD 2).
 * Self-contained on purpose (node: built-ins only), like frozen-paths.mjs: CI loads it from a temporary file. The fence
 * added-run needs is loaded from the bytes it hashed (a data: URL), never by a path a test could rewrite in between.
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

/** The verdict rule for added tests, in one sentence (the job summary says it when the job is red). */
export const ADDED_TEST_RULE = 'An added test file passes only when the runner loaded it, at least one of its tests passed, none failed, none was skipped, todo or cancelled, and the runner exited 0.'

/** The key a test is counted by: its file (relative to the checkout) and its full name. */
const key = (file, name) => `${file}::${name}`

/**
 * node --test reporter: one JSON line per finished test. A skipped or todo test is not 'passed'. Nested tests carry their
 * parents' names (`parent > child`), tracked per file from the start events. A describe() suite's own result carries
 * `suite: true`: it is not a test, so it never stands in for a skipped test inside it.
 * A file's own result (node reports one when the file reported no test, or failed outside its tests, e.g. it threw while
 * loading) carries `fileSummary: true`: it is told from a test by who made the record, never by
 * its name. Node 24 (the version the workflow sets up) makes that record itself, in the runner process, as an object with
 * no prototype; every test's record arrives from the file's own test process, deserialized as a plain object. A test named
 * after its file is therefore still a test. Should a later node make both alike, every record reads as a file summary and
 * no test passes: red, never a quiet green.
 * @param {AsyncIterable<{ type: string, data: Record<string, unknown> }>} source The runner's events.
 */
export default async function* retentionReporter(source) {
  const stacks = new Map()
  const stackOf = file => { let stack = stacks.get(file); if (!stack) stacks.set(file, stack = []); return stack }
  for await (const event of source) {
    const data = event.data ?? {}, file = typeof data.file === 'string' ? data.file : '', nesting = Number.isInteger(data.nesting) ? data.nesting : 0
    if (event.type === 'test:start') { const stack = stackOf(file); stack.length = nesting; stack[nesting] = String(data.name) }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    const stack = stackOf(file), names = [...stack.slice(0, nesting), String(data.name)]
    const status = event.type === 'test:fail' ? 'failed' : data.skip !== undefined || data.todo !== undefined ? 'skipped' : 'passed'
    yield JSON.stringify({ status, file, name: names.join(' > '), ...(data.details?.type === 'suite' ? { suite: true } : {}),
      ...(Object.getPrototypeOf(event.data) === null ? { fileSummary: true } : {}) }) + '\n'
  }
}

/**
 * The results of a node --test run from the reporter's lines.
 * @param {string} text The reporter's output.
 * @param {string} root The checkout the files are relative to.
 * @returns {{ status: string, name: string, suite?: true, fileSummary?: true }[]}
 */
export function nodeResults(text, root) {
  const results = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    const value = JSON.parse(line)
    if (typeof value?.status !== 'string' || typeof value.name !== 'string' || typeof value.file !== 'string'
      || (Object.hasOwn(value, 'suite') && value.suite !== true) || (Object.hasOwn(value, 'fileSummary') && value.fileSummary !== true)) throw new Error('RETENTION_LINE_INVALID')
    const path = value.file.startsWith('file:') ? fileURLToPath(value.file) : value.file
    results.push({ status: value.status, name: key(isAbsolute(path) ? relative(root, path) : path, value.name), ...(value.suite === true ? { suite: true } : {}),
      ...(value.fileSummary === true ? { fileSummary: true } : {}) })
  }
  return results
}

/**
 * The results of a vitest run from its JSON reporter's file (testResults[].assertionResults[]).
 * @param {string} text The JSON.
 * @param {string} root The checkout the files are relative to.
 * @returns {{ status: string, name: string }[]}
 */
export function vitestResults(text, root) {
  const value = JSON.parse(text), results = []
  if (!Array.isArray(value?.testResults)) throw new Error('RETENTION_JSON_INVALID')
  for (const file of value.testResults) {
    if (typeof file?.name !== 'string' || !Array.isArray(file.assertionResults)) throw new Error('RETENTION_JSON_INVALID')
    const path = isAbsolute(file.name) ? relative(root, file.name) : file.name
    // A file that failed as a whole (it threw while loading, so no test was collected) is a failure named by the file,
    // as node names it (MUST 3): never a quiet file with nothing in it. This judge makes that record itself, so it
    // carries `fileSummary: true`; a test of the file named like the file is a test.
    if (file.status === 'failed' && !file.assertionResults.some(test => test?.status === 'failed')) results.push({ status: 'failed', name: key(path, basename(path)), fileSummary: true })
    for (const test of file.assertionResults) {
      if (typeof test?.status !== 'string' || typeof test.fullName !== 'string') throw new Error('RETENTION_JSON_INVALID')
      results.push({ status: test.status, name: key(path, test.fullName) })
    }
  }
  return results
}

const passedNames = results => results.filter(result => result.status === 'passed').map(result => result.name).sort()

/**
 * The identities (file::full name) that more than one test of a run carries, whatever their status (SHOULD 1):
 * two tests named alike in one file could swap a pass for a skip and still be counted as kept.
 * @param {{ status: string, name: string }[]} results
 * @returns {string[]} Each such identity once, sorted.
 */
export function duplicateNames(results) {
  const seen = new Set(), twice = new Set()
  for (const { name } of results) (seen.has(name) ? twice : seen).add(name)
  return [...twice].sort()
}

/**
 * Main's own run: green only when nothing failed, something passed and every test's identity is its own.
 * @param {{ status: string, name: string }[]} results
 * @param {number} exitCode The runner's exit code.
 * @returns {{ ok: boolean, red: string[], passed: string[], reason?: string }}
 */
export function baselineVerdict(results, exitCode) {
  const red = results.filter(result => result.status === 'failed').map(result => result.name).sort(), passed = passedNames(results)
  if (red.length) return { ok: false, red, passed, reason: `main's own baseline is red: ${red.join(', ')}` }
  if (!passed.length) return { ok: false, red, passed, reason: "main's own baseline ran nothing" }
  const twice = duplicateNames(results)
  if (twice.length) return { ok: false, red, passed, reason: `main's own baseline has ${twice.length} test identity(ies) carried by two or more tests of one file; give each its own name: ${twice.join(', ')}` }
  if (exitCode !== 0) return { ok: false, red, passed, reason: `main's own baseline exited ${exitCode}` }
  return { ok: true, red, passed }
}

/**
 * The proposal's run against main's: every passed name of main, counted with its multiplicity, must be passed here.
 * @param {string[]} baseline The names that passed on main.
 * @param {{ status: string, name: string }[]} results The proposal's results.
 * @param {number} exitCode The runner's exit code.
 * @returns {{ ok: boolean, missing: string[], reason?: string }}
 */
export function retentionVerdict(baseline, results, exitCode) {
  const left = new Map()
  for (const name of passedNames(results)) left.set(name, (left.get(name) ?? 0) + 1)
  const missing = []
  for (const name of baseline) {
    const count = left.get(name) ?? 0
    if (count > 0) left.set(name, count - 1)
    else missing.push(name)
  }
  if (!baseline.length) return { ok: false, missing, reason: 'the baseline holds no passed test' }
  if (missing.length) return { ok: false, missing, reason: `${missing.length} test(s) that passed on main did not pass here: ${missing.join(', ')}` }
  if (exitCode !== 0) return { ok: false, missing, reason: `every name of main passed, but the run exited ${exitCode}` }
  return { ok: true, missing }
}

/** Names on one line for a job output: gzip, base64. */
export const packNames = names => gzipSync(Buffer.from(names.join('\n'), 'utf8')).toString('base64')
export const unpackNames = packed => { const text = gunzipSync(Buffer.from(String(packed).trim(), 'base64')).toString('utf8'); return text ? text.split('\n') : [] }

/**
 * SHOULD 2: the packed names ride in one job output and then in one environment string of the job that compares;
 * Linux refuses to start a process with one environment string over 128 KiB (MAX_ARG_STRLEN 131072 bytes, the NAME= part
 * included). This cap leaves room for the name. Over it the baseline job fails and says which job and how large; the
 * list is never truncated (a truncated list would drop names from what must be kept).
 */
export const PACKED_NAMES_MAX_BYTES = 120 * 1024
const packedTooLarge = (suite, bytes) => `::error::retention ${suite}: the packed passed names of job ${suite} are ${bytes} bytes, over the cap of ${PACKED_NAMES_MAX_BYTES} bytes; they are not truncated: split the suite or carry the names another way`

/**
 * The added test files' run (MUST 3, replacing an earlier declared-count floor): no source is read and nothing
 * is counted from spellings; the runner's own events decide. ADDED_TEST_RULE: every added file was loaded by the runner (a
 * file it never reported is a failure); in each file at least one test passed; no test failed; none was skipped, todo or
 * cancelled (node reports a cancelled test as failed; a skip or todo is 'skipped' whatever its spelling: the reporter's
 * event says so, not the source); the runner exited 0. A describe() suite is not a test, but a suite
 * that failed or was skipped counts as one. A file's own result (`fileSummary: true`, never told by its name: an independent
 * review, MUST 5) is how a file that threw while loading is reported: it counts as loaded and as failed, never as a
 * passed test. Each problem names the file and the test.
 * @param {string[]} files The added files, repository-relative (the inventory, taken before the run).
 * @param {{ status: string, name: string, suite?: true, fileSummary?: true }[]} results The run's results (file::name).
 * @param {number} exitCode The runner's exit code.
 * @returns {{ ok: boolean, problems: string[], reason?: string }}
 */
export function addedVerdict(files, results, exitCode) {
  const problems = [], inventory = new Set(files)
  for (const file of files) {
    const own = results.filter(result => result.name.startsWith(file + '::')).map(result => ({ ...result, test: result.name.slice(file.length + 2) }))
    if (!own.length) { problems.push(`${file}: the runner never reported this file (it was not loaded)`); continue }
    const fileLevel = result => result.fileSummary === true
    for (const result of own) {
      const label = fileLevel(result) ? `${file} (the file itself)` : `${file} :: ${result.test}`
      if (result.status === 'failed') problems.push(`${label}: failed`)
      else if (result.status !== 'passed') problems.push(`${label}: ${result.status} (an added test may not be skipped, todo or cancelled)`)
    }
    if (!own.some(result => result.status === 'passed' && result.suite !== true && !fileLevel(result))) problems.push(`${file}: no test of this file passed`)
  }
  // Results the inventory does not name: the runner ran something the verdict was not asked about.
  for (const result of results) if (![...inventory].some(file => result.name.startsWith(file + '::'))) problems.push(`${result.name}: reported for a file the proposal did not add`)
  if (problems.length) return { ok: false, problems, reason: `${problems.length} problem(s) with the added tests` }
  if (exitCode !== 0) return { ok: false, problems, reason: `every added test passed, but the run exited ${exitCode}` }
  return { ok: true, problems }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * MUST 2: one trusted process judges the added tests and is the parent of them. Order: its own source and the
 * fence hashed; the inventory read from git with the fence held in memory; every added file's bytes hashed; an empty
 * inventory answered here, before anything runs; the runner spawned (results on a pipe this process owns, or for vitest in
 * a file named at random in a folder this process made, read once and compared by size and hash before parsing); the
 * verdict from the inventory and the results; then every hash taken again, failing closed on any change.
 * @param {{ suite: string, runner: 'node'|'vitest', fence: string, main: string, head: string, root: string, print: (line: string) => void,
 *   spawn?: typeof spawnSync, self?: string }} options `spawn` and `self` exist for tests only.
 * @returns {Promise<number>} The exit code.
 */
export async function addedRun({ suite, runner, fence, main, head, root, print, spawn = spawnSync, self = fileURLToPath(import.meta.url) }) {
  const fail = line => { print(`::error::retention ${suite}: ${line}`); summary(suite, `red: ${line}`); return 1 }
  if (!['node', 'vitest'].includes(runner) || !/^[0-9a-f]{40}$/.test(main) || !/^(?:HEAD|[0-9a-f]{40})$/.test(head)) return fail('added-run needs --runner node|vitest, --main <sha> and --head <sha|HEAD>')
  const selfBytes = readFileSync(self)
  const own = { [self]: sha256(selfBytes) }
  let judge, inventory
  try {
    const fenceBytes = readFileSync(fence)
    own[fence] = sha256(fenceBytes)
    judge = await import('data:text/javascript;base64,' + fenceBytes.toString('base64'))
    const diff = execFileSync('git', ['diff', '--no-renames', '--no-ext-diff', '--name-status', '-z', `${main}...${head}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    inventory = judge.addedTestFiles(diff)[runner]
  } catch (error) { return fail(`the inventory could not be read from git (${error?.message ?? error})`) }
  if (!Array.isArray(inventory)) return fail('the fence gave no inventory')
  // Decided before the run, never after it: no added file of this runner means nothing runs.
  if (!inventory.length) { print(`retention ${suite}: the proposal adds no test file for this runner`); return 0 }
  const held = new Map()
  try { for (const file of inventory) held.set(file, sha256(readFileSync(resolve(root, file)))) } catch (error) { return fail(`an added file could not be read (${error?.message ?? error})`) }
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const ran = runSuite({ runner, args: inventory, root, env, reporter: reporterOf(selfBytes), spawn, prefix: 'retention-added-', exact: true })
  if (ran.error) return fail(ran.error)
  const { results, exitCode } = ran
  const verdict = addedVerdict(inventory, results, exitCode)
  // Before answering: nothing the verdict reads may have changed while the tests ran.
  for (const [path, hash] of [...held.entries()].map(([file, hash]) => [resolve(root, file), hash]).concat(Object.entries(own))) {
    let now = null
    try { now = sha256(readFileSync(path)) } catch (_error) { /* a deleted file is a changed one */ }
    if (now !== hash) return fail(`an added test changed a file the verdict reads (${relative(resolve(root), path) || path}); nothing is decided from it`)
  }
  if (!verdict.ok) { fail(verdict.reason); for (const line of verdict.problems) print(`problem: ${line}`); print(ADDED_TEST_RULE); return 1 }
  print(`retention ${suite}: all ${inventory.length} added file(s) loaded, every test passed, none skipped`)
  summary(suite, `green: ${inventory.length} added file(s)`)
  return 0
}

/** The reporter a runner loads: this file's own bytes as the judge read them before anything ran (a data: URL), never a
 * path a test could rewrite in between. Self-contained, so it loads from bytes. */
const reporterOf = bytes => `data:text/javascript;base64,${bytes.toString('base64')}`

/**
 * Review, MUST 6: the added vitest files run EXACTLY, never through vitest's command-line filters (a filter is
 * a substring of a path: `identity-devices.client.spec.ts` also selects main's `identity-devices.client.spec.tsx`). This
 * script, held here and given to node with `-e` (never a file a test could rewrite), loads the checkout's vitest (main's
 * lockfile installed it), lets it resolve main's configuration and glob as always, keeps only the specifications whose
 * module is one of the added files by its exact absolute path, and runs those, with the JSON results in the file this
 * judge names. An added file no project includes is never run, so the verdict says it was not loaded. Arguments: the
 * results file, then the added files (relative to the checkout, which is the working folder).
 */
export const VITEST_EXACT_RUNNER = `import { resolve } from 'node:path'
const { createVitest } = await import('vitest/node')
const [out, ...files] = process.argv.slice(1)
const wanted = new Set(files.map(file => resolve(file)))
const vitest = await createVitest('test', { watch: false, reporters: ['default', 'json'], outputFile: { json: out } })
const specifications = vitest.specifications, glob = specifications.getRelevantTestSpecifications.bind(specifications)
specifications.getRelevantTestSpecifications = async filters => (await glob(filters)).filter(spec => wanted.has(spec.moduleId))
try { await vitest.start(files) } catch (error) { process.exitCode = 1; console.error(error) } finally { await vitest.close() }
process.exit(process.exitCode ?? 0)
`

/**
 * One run of a runner, with its results on a pipe this process owns (node: the reporter on stdout, the spec on stderr) or
 * in a file named at random in a folder this process made (vitest: read once, compared by size and hash, then parsed).
 * `exact` (added-run): vitest runs the given files by exact path (VITEST_EXACT_RUNNER), not by its filters.
 * @returns {{ results: { status: string, name: string, suite?: true, fileSummary?: true }[], exitCode: number } | { error: string }}
 */
function runSuite({ runner, args, root, env, reporter, spawn, prefix, exact = false }) {
  if (runner === 'node') {
    const ran = spawn(process.execPath, ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', '--test-reporter=spec', '--test-reporter-destination=stderr', ...args],
      { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
    const exitCode = Number.isInteger(ran.status) ? ran.status : 1
    try { return { results: nodeResults(ran.stdout ?? '', resolve(root)), exitCode } } catch (error) { return { error: `the runner's results could not be read (${error?.message ?? error})` } }
  }
  const folder = mkdtempSync(join(tmpdir(), prefix)), out = join(folder, `${randomUUID()}.json`)
  try {
    const ran = exact ? spawn(process.execPath, ['--input-type=module', '-e', VITEST_EXACT_RUNNER, '--', out, ...args], { cwd: root, env, stdio: 'inherit' })
      : spawn('pnpm', ['exec', 'vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`, ...args], { cwd: root, env, stdio: 'inherit' })
    const exitCode = Number.isInteger(ran.status) ? ran.status : 1
    let bytes
    try { bytes = readFileSync(out) } catch (error) { return { error: `the runner wrote no results (${error?.code ?? error}); a run that wrote nothing is a failure` } }
    const again = readFileSync(out)
    if (again.length !== bytes.length || sha256(again) !== sha256(bytes)) return { error: 'the results changed while they were read' }
    try { return { results: vitestResults(bytes.toString('utf8'), resolve(root)), exitCode } } catch (error) { return { error: `the runner's results could not be read (${error?.message ?? error})` } }
  } finally { rmSync(folder, { recursive: true, force: true }) }
}

/**
 * Review, MUST 1: the files a protected job put back from main (its tests, helpers and configuration), each
 * hashed. A folder is walked whole (its node_modules excepted: the lockfile is main's and nothing is held there); a path
 * the job did not put back (main has none) holds nothing. A symbolic link is held by its target's name, never followed.
 * @param {string} root The checkout.
 * @param {string[]} paths Repository-relative paths, as the workflow lists them.
 * @returns {Map<string, string>} Repository-relative file -> sha256.
 */
export function holdFiles(root, paths) {
  const held = new Map()
  const visit = relativePath => {
    const absolute = resolve(root, relativePath)
    let stat
    try { stat = lstatSync(absolute) } catch (error) { if (error?.code === 'ENOENT') return; throw error }
    if (stat.isSymbolicLink()) held.set(relativePath, sha256(Buffer.from('symlink:' + readlinkSync(absolute))))
    else if (stat.isDirectory()) { for (const name of readdirSync(absolute).sort()) if (name !== 'node_modules') visit(join(relativePath, name)) }
    else if (stat.isFile()) held.set(relativePath, sha256(readFileSync(absolute)))
  }
  for (const path of paths) {
    if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`RETENTION_HOLD_INVALID ${path}`)
    visit(path)
  }
  return held
}

/** The first held file whose bytes are not the ones held (or that is gone), or null. */
function changedHeld(root, held) {
  for (const [file, hash] of held) {
    let now = null
    try { now = holdFiles(root, [file]).get(file) ?? null } catch (_error) { /* unreadable is changed */ }
    if (now !== hash) return file
  }
  return null
}

/** A path's state in the checkout: its bytes' hash, a link's target, a folder, or gone. */
function pathState(absolute) {
  let stat
  try { stat = lstatSync(absolute) } catch (error) { return error?.code === 'ENOENT' ? 'gone' : `unreadable ${error?.code ?? error}` }
  if (stat.isSymbolicLink()) return `link ${readlinkSync(absolute)}`
  if (stat.isDirectory()) return 'folder'
  return stat.isFile() ? `file ${sha256(readFileSync(absolute))}` : 'other'
}

/** A node_modules folder's packages (names not starting with a dot; a scope's packages too), each with its kind. */
function packagesState(absolute) {
  let names
  try { names = readdirSync(absolute).sort() } catch (error) { return error?.code === 'ENOENT' ? 'absent' : `unreadable ${error?.code ?? error}` }
  const listed = []
  for (const name of names.filter(entry => !entry.startsWith('.'))) {
    const state = pathState(join(absolute, name))
    listed.push(`${name} ${state}`)
    if (name.startsWith('@') && state === 'folder') for (const inner of readdirSync(join(absolute, name)).sort()) listed.push(`${name}/${inner} ${pathState(join(absolute, name, inner))}`)
  }
  return sha256(Buffer.from(listed.join('\n')))
}

/**
 * Review, SHOULD: the rest of the checkout, so that one run cannot prepare the ground for the next outside
 * the files the job put back either. Read from git itself (the runner's checkout is a work tree): the index (with its
 * flags, so a file marked unchanged is seen), and every path `git status` names (a tracked file rewritten or staged, a
 * file added beside one), each with its bytes' hash; and the packages of every node_modules folder on the way from a
 * held file up to the checkout (git ignores them, and a package planted in one is what a held test would import).
 * What it does NOT cover: a change git does not show (inside another ignored folder, or a file inside a package already
 * there), a change to the .git folder that hides one, or a change put back before the next check.
 * @param {string} root The checkout.
 * @param {Map<string, string>} held What holdFiles returned.
 * @returns {Map<string, string>} Name -> state.
 */
export function checkoutState(root, held) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  const git = args => {
    const ran = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], { cwd: root, env, maxBuffer: 256 * 1024 * 1024 })
    if (ran.status !== 0) throw new Error(`git ${args[0]} answered ${ran.status ?? ran.signal ?? ran.error?.code}`)
    return ran.stdout
  }
  if (realpathSync(git(['rev-parse', '--show-toplevel']).toString('utf8').trim()) !== realpathSync(root)) throw new Error('the checkout is not the top of its git work tree')
  const state = new Map([['the git index', sha256(git(['ls-files', '-s', '-v', '-z']))]])
  for (const entry of git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none']).toString('utf8').split('\0')) {
    if (entry.length < 4) continue
    state.set(entry.slice(3), `${entry.slice(0, 2)} ${pathState(resolve(root, entry.slice(3)))}`)
  }
  const folders = new Set(['.'])
  for (const file of held.keys()) for (let folder = dirname(file); folder !== '.' && !folders.has(folder); folder = dirname(folder)) folders.add(folder)
  for (const folder of [...folders].sort()) {
    const name = folder === '.' ? 'node_modules' : `${folder}/node_modules`
    state.set(name, packagesState(resolve(root, name)))
  }
  return state
}

/** The first name whose state is not the one held (or that appeared), or null. */
function changedCheckout(root, held, before) {
  let now
  try { now = checkoutState(root, held) } catch (_error) { return 'the checkout (its state could not be read from git)' }
  for (const name of new Set([...before.keys(), ...now.keys()])) if (before.get(name) !== now.get(name)) return name
  return null
}

/**
 * A protected job's suites, judged by name in ONE trusted process that is the parent of every run (MUST 1:
 * before it, the judge file, a results file and an exit file sat in RUNNER_TEMP between steps, where the code the
 * suite runs could rewrite them). Order: its own bytes read and hashed; every run's baseline names read from the
 * environment and checked (an empty or over-cap list is refused before anything runs); each run spawned with its reporter
 * loaded from the held bytes and its results on this process's own pipe or file; each run judged like `compare`; then its
 * own source hashed again, failing closed on any change. Review, MUST 1: before the first run every file under
 * `hold` (what the job put back from main) is hashed, and checked again before each later run and before answering; a
 * run that changed one ends the job red, naming the file, and no later run starts. What it does NOT cover, as for
 * added-run: a test that forges the runner's own event stream from inside the runner process, or finds the vitest results
 * file as the same user, or changes a held file and puts its bytes back before the next check.
 * @param {{ runs: { suite: string, runner: 'node'|'vitest', baselineEnv: string, args: string[] }[], root: string, hold: string[],
 *   print: (line: string) => void, spawn?: typeof spawnSync, self?: string, env?: Record<string, string | undefined> }} options
 *   `spawn`, `self` and `env` exist for tests only.
 * @returns {number} The exit code.
 */
export function protectedRun({ runs, root, hold, print, spawn = spawnSync, self = fileURLToPath(import.meta.url), env: source = process.env }) {
  const fail = line => { print(`::error::retention: ${line}`); return 1 }
  if (!Array.isArray(runs) || !runs.length || typeof root !== 'string') return fail('protected-run needs --root and at least one run')
  if (!Array.isArray(hold) || !hold.length) return fail('protected-run needs --hold, the paths the job put back from main; nothing was run')
  let selfBytes
  try { selfBytes = readFileSync(self) } catch (error) { return fail(`the judge could not read itself (${error?.code ?? error})`) }
  const selfHash = sha256(selfBytes), held = []
  // Every input held before anything runs.
  for (const run of runs) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(run?.suite ?? '') || !['node', 'vitest'].includes(run.runner) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(run.baselineEnv ?? '')
      || !Array.isArray(run.args) || !run.args.length || !run.args.every(arg => typeof arg === 'string' && arg !== '')) return fail('each run needs --suite, --runner node|vitest, --baseline-env <NAME> and its runner arguments after --')
    const carried = source[run.baselineEnv] ?? ''
    if (Buffer.byteLength(carried) > PACKED_NAMES_MAX_BYTES) { print(packedTooLarge(run.suite, Buffer.byteLength(carried))); return 1 }
    let names
    try { names = unpackNames(carried) } catch (_error) { names = [] }
    if (!names.length) return fail(`${run.suite}: the baseline holds no passed test (${run.baselineEnv}); nothing was run`)
    held.push({ ...run, names })
  }
  const env = { ...source }
  delete env.NODE_TEST_CONTEXT
  for (const run of runs) delete env[run.baselineEnv]
  const reporter = reporterOf(selfBytes)
  let restored
  try { restored = holdFiles(root, hold) } catch (error) { return fail(`the files the job put back could not be read (${error?.message ?? error}); nothing was run`) }
  if (!restored.size) return fail('--hold names no file the job put back; nothing was run')
  // Review, SHOULD: the rest of the checkout, held the same way (from git, and the node_modules beside it).
  let checkout
  try { checkout = checkoutState(root, restored) } catch (error) { return fail(`the checkout's state could not be read from git (${error?.message ?? error}); nothing was run`) }
  const rewritten = (file, when) => fail(`a test changed ${file} (put back from main for this job) ${when}; nothing is decided from this run`)
  const moved = (name, when) => fail(`a test changed ${name} (in the checkout) ${when}; nothing is decided from this run`)
  let red = 0
  for (const [index, run] of held.entries()) {
    if (index > 0) { const file = changedHeld(root, restored); if (file !== null) return rewritten(file, `before the ${run.suite} run`) }
    if (index > 0) { const name = changedCheckout(root, restored, checkout); if (name !== null) return moved(name, `before the ${run.suite} run`) }
    const ran = runSuite({ runner: run.runner, args: run.args, root, env, reporter, spawn, prefix: 'retention-protected-' })
    if (ran.error) { print(`::error::retention ${run.suite}: ${ran.error}`); red++; continue }
    const verdict = retentionVerdict(run.names, ran.results, ran.exitCode)
    if (!verdict.ok) { print(`::error::retention ${run.suite}: ${verdict.reason}`); for (const name of verdict.missing) print(`missing: ${name}`); red++; continue }
    print(`retention ${run.suite}: all ${run.names.length} test(s) that passed on main passed here`)
  }
  // Before answering: the judge is still the bytes it started as.
  let now = null
  try { now = sha256(readFileSync(self)) } catch (_error) { /* a deleted judge is a changed one */ }
  if (now !== selfHash) return fail('a test changed the judge (retention.mjs) while the suites ran; nothing is decided from this run')
  const file = changedHeld(root, restored)
  if (file !== null) return rewritten(file, 'while the suites ran')
  const name = changedCheckout(root, restored, checkout)
  if (name !== null) return moved(name, 'while the suites ran')
  return red ? 1 : 0
}

/**
 * protected-run's arguments: `--root <dir> --hold "<paths, space-separated>"` and one or more runs, each `--suite <name>
 * --runner node|vitest --baseline-env <NAME> -- <runner args>...`, separated by `--and`.
 * @param {string[]} argv
 * @returns {{ root: string, hold: string[], runs: { suite: string, runner: string, baselineEnv: string, args: string[] }[] } | null}
 */
export function protectedRunArguments(argv) {
  if (argv[0] !== '--root' || typeof argv[1] !== 'string' || argv[2] !== '--hold' || typeof argv[3] !== 'string') return null
  const hold = argv[3].split(/\s+/).filter(Boolean)
  if (!hold.length) return null
  const runs = []
  let index = 4
  while (index < argv.length) {
    const [s, suite, r, runner, b, baselineEnv, dashes] = argv.slice(index, index + 7)
    if (s !== '--suite' || r !== '--runner' || b !== '--baseline-env' || dashes !== '--' || [suite, runner, baselineEnv].some(value => typeof value !== 'string')) return null
    index += 7
    const args = []
    while (index < argv.length && argv[index] !== '--and') args.push(argv[index++])
    runs.push({ suite, runner, baselineEnv, args })
    if (argv[index] === '--and') { index++; if (index >= argv.length) return null }
  }
  return runs.length ? { root: argv[1], hold, runs } : null
}

/** One line in the job summary, with the rule, so she reads it when red. */
function summary(suite, line) {
  if (!process.env.GITHUB_STEP_SUMMARY) return
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `retention ${suite}: ${line}. Rule: ${ADDED_TEST_RULE}\n`) } catch (_error) { /* the summary is a courtesy */ }
}

function options(argv) {
  const value = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index].startsWith('--') || argv[index + 1] === undefined) throw new Error(`RETENTION_ARGUMENT_INVALID ${argv[index]}`)
    value[argv[index].slice(2)] = argv[index + 1]
  }
  return value
}

/**
 * The command line (see the header). Returns the exit code; prints GitHub annotations.
 * @param {string[]} argv
 * @param {(line: string) => void} print
 * @returns {number}
 */
export function main(argv, print = line => console.log(line)) {
  const [command, ...rest] = argv
  if (command === 'protected-run') {
    const parsed = protectedRunArguments(rest)
    if (parsed === null) {
      print('::error::retention: usage: protected-run --root <dir> --hold "<paths>" --suite <name> --runner node|vitest --baseline-env <NAME> -- <runner args>... [--and --suite ...]')
      return 2
    }
    return protectedRun({ ...parsed, print })
  }
  let parsed
  try { parsed = options(rest) } catch (_error) { parsed = null }
  if (command === 'added-run' && parsed !== null) {
    const { suite = '?', root = process.cwd(), runner, fence, main: mainSha, head } = parsed
    if (Object.keys(parsed).some(name => !['suite', 'root', 'runner', 'fence', 'main', 'head'].includes(name)) || fence === undefined) {
      print('::error::retention: usage: added-run --suite <name> --runner node|vitest --fence <frozen-paths.mjs> --main <sha> --head <sha|HEAD> --root <dir>')
      return 2
    }
    return addedRun({ suite, runner, fence, main: mainSha, head, root, print })
  }
  const { suite = '?', root = process.cwd(), exit, node, vitest, baseline, 'baseline-env': baselineEnv } = parsed ?? {}
  const exitCode = Number(exit)
  if (parsed === null || !['baseline', 'compare'].includes(command) || !Number.isInteger(exitCode) || (node === undefined) === (vitest === undefined)
    || (baselineEnv !== undefined && (baseline !== undefined || !/^[A-Z][A-Z0-9_]{0,63}$/.test(baselineEnv)))) {
    print('::error::retention: usage: baseline|compare --suite <name> (--node <lines>|--vitest <json>) --root <dir> --exit <code> [--baseline-env <NAME> | --baseline <packed>]; added-run --suite <name> --runner node|vitest --fence <frozen-paths.mjs> --main <sha> --head <sha|HEAD> --root <dir>')
    return 2
  }
  let results
  try { results = node !== undefined ? nodeResults(readFileSync(node, 'utf8'), resolve(root)) : vitestResults(readFileSync(vitest, 'utf8'), resolve(root)) } catch (error) {
    print(`::error::retention ${suite}: the results could not be read (${error?.message ?? error}); a run that wrote nothing is a failure`)
    return 1
  }
  if (command === 'baseline') {
    const verdict = baselineVerdict(results, exitCode)
    if (!verdict.ok) { print(`::error::retention ${suite}: ${verdict.reason}`); return 1 }
    const packed = packNames(verdict.passed), bytes = Buffer.byteLength(packed)
    if (bytes > PACKED_NAMES_MAX_BYTES) { print(packedTooLarge(suite, bytes)); return 1 }
    print(packed)
    return 0
  }
  const carried = (baselineEnv !== undefined ? process.env[baselineEnv] : baseline) ?? ''
  if (Buffer.byteLength(carried) > PACKED_NAMES_MAX_BYTES) { print(packedTooLarge(suite, Buffer.byteLength(carried))); return 1 }
  let names
  try { names = unpackNames(carried) } catch (_error) { names = [] }
  const verdict = retentionVerdict(names, results, exitCode)
  if (!verdict.ok) { print(`::error::retention ${suite}: ${verdict.reason}`); for (const name of verdict.missing) print(`missing: ${name}`); return 1 }
  print(`retention ${suite}: all ${names.length} test(s) that passed on main passed here`)
  return 0
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2))
