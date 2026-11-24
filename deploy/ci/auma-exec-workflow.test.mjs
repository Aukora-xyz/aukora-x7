// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/auma-exec-workflow.test.mjs  (reads .github/workflows/auma-exec.yml; runs its validation step in bash; no network)
//
// Auma-exec.yml runs a command Auma wrote on a throwaway GitHub runner. It must stay a machine with no secret and no
// write: started only by hand (workflow_dispatch, which her exec door sends), `contents: read` and nothing else, no
// `secrets.` anywhere, a checkout that keeps no credential, every action pinned by commit, and no input ever interpolated
// into a script (`${{ inputs.* }}` inside `run:` is a script-injection hole: inputs travel only through `env:`). Its first
// step refuses what the edge refuses (cloud-brokers.mjs aumaExecInputs): the two agree case by case below.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AUMA_EXEC_LIMITS, AUMA_EXEC_WORKFLOW, aumaExecInputs } from '../cloudflare/src/cloud-brokers.mjs'

const FILE = fileURLToPath(new URL('../../.github/workflows/auma-exec.yml', import.meta.url))
const source = readFileSync(FILE, 'utf8')
const code = source.replace(/^\s*#[^\n]*\n/gm, '')

/** Top-level keys and their bodies (a body is every indented line under the key). */
const topLevel = text => Object.fromEntries(text.split(/\n(?=[a-z-]+:)/).map(block => {
  const [first, ...rest] = block.split('\n')
  const [key, ...inline] = first.split(':')
  return [key.trim(), [inline.join(':').trim(), ...rest].join('\n')]
}))
/** Step bodies of a workflow (each begins at its `      - ` line). */
const stepsOf = text => text.split('\njobs:\n')[1].split(/\n(?= {6}- )/).slice(1)
/** The script of a step's `run:`, block or single line; '' when the step has none. */
const scriptOf = step => {
  const block = step.split(/\n {8}run: \|\n/)[1]
  if (block !== undefined) return block.split('\n').filter(line => line.startsWith('          ') || line === '').map(line => line.slice(10)).join('\n')
  return step.match(/\n {8}run: (.+)/)?.[1] ?? ''
}
const nameOf = step => step.match(/- name: (.+)/)?.[1] ?? step.slice(0, 40)
/** Refusals of the injection rule: a step whose script carries an expression. */
const injected = text => stepsOf(text).filter(step => /\$\{\{/.test(scriptOf(step))).map(nameOf)

test('auma-exec.yml is started only by hand and holds contents: read and nothing else', () => {
  assert.equal(AUMA_EXEC_WORKFLOW.path, '.github/workflows/auma-exec.yml')
  const keys = topLevel(code)
  assert.deepEqual(Object.keys(keys).filter(key => key !== 'name').sort(), ['concurrency', 'jobs', 'on', 'permissions', 'run-name'])
  assert.match(keys.on, /^\n {2}workflow_dispatch:\n/)
  assert.doesNotMatch(code, /^\s*(?:push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch|issue_comment):/m)
  assert.deepEqual([...code.matchAll(/^\s*permissions:([^\n]*)\n((?: {2,}\S[^\n]*\n)*)/gm)].map(match => (match[1] + match[2]).trim()), ['contents: read'])
  assert.equal([...code.matchAll(/permissions/g)].length, 1)
  assert.doesNotMatch(code, /:\s*write\b|write-all/)
})

test('no secret, no token and no environment reach it; the checkout keeps no credential; every action is pinned by commit', () => {
  assert.doesNotMatch(source, /secrets\./)
  assert.doesNotMatch(source, /github\.token|GH_TOKEN|GITHUB_TOKEN|vars\.|^\s*environment:/m)
  const checkouts = stepsOf(code).filter(step => /uses: actions\/checkout@/.test(step))
  assert.equal(checkouts.length, 1)
  for (const step of checkouts) assert.match(step, /\n {10}persist-credentials: false\n/)
  const uses = code.match(/uses: \S+/g)
  assert.equal(uses.length, 4)
  for (const item of uses) assert.match(item, /^uses: [a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/, item)
})

test('no input is ever interpolated into a script: every input reaches a shell only through env', () => {
  assert.deepEqual(injected(code), [])
  // The guard catches the hole it is for (a command interpolated into run:, block or single line).
  const holed = code.replace('bash -eo pipefail -c "$AUMA_COMMAND"', 'bash -eo pipefail -c "${{ inputs.command }}"')
  assert.notEqual(holed, code)
  assert.deepEqual(injected(holed), ['Run her command'])
  assert.deepEqual(injected(code.replace('run: pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile', 'run: echo ${{ inputs.label }}')), ['Install dependencies without lifecycle scripts'])
  // Nothing reads github.event inputs or the raw payload either.
  assert.doesNotMatch(code, /github\.event/)
  const run = stepsOf(code).find(step => nameOf(step) === 'Run her command')
  assert.match(run, /\n {8}env:\n {10}AUMA_COMMAND: \$\{\{ inputs\.command \}\}\n/)
  assert.match(scriptOf(run), /^cd \/home\/auma\/repo\nset \+e\nsudo -u auma env -i PATH="\$AUMA_PATH" HOME=\/home\/auma [^\n]* bash -eo pipefail -c "\$AUMA_COMMAND"\ncode=\$\?\n/)
  assert.match(scriptOf(run), /exit "\$code"/)
})

test('her command runs as auma, a user with no sudo and no other group, and nothing of hers runs as the runner', () => {
  const steps = stepsOf(code), names = steps.map(nameOf)
  const at = name => { const index = names.indexOf(name); assert.ok(index >= 0, name); return index }
  const user = scriptOf(steps[at('Make her user (no sudo) and give her the checkout')])
  // Made with its own group only, checked to have no sudo, links protected, and given the checkout and $ARTIFACTS.
  assert.match(user, /^sudo useradd --create-home --home-dir \/home\/auma --shell \/bin\/bash --user-group auma$/m)
  assert.match(user, /case "\$\(sudo -n -l -U auma 2>&1\)" in \*"may run the following"\*\) echo "::error::auma may use sudo"; exit 1 ;; esac/)
  assert.match(user, /\[ "\$\(id -nG auma\)" = auma \] \|\| \{ echo "::error::auma is in another group"; exit 1; \}/)
  assert.match(user, /protected_hardlinks\)" = 1 \] && \[ "\$\(cat \/proc\/sys\/fs\/protected_symlinks\)" = 1 \]/)
  assert.match(user, /^sudo mv "\$GITHUB_WORKSPACE" \/home\/auma\/repo$/m)
  assert.match(user, /^sudo chown -R auma:auma \/home\/auma\/repo \/home\/auma\/artifacts$/m)
  // Her PATH leaves out the runner's home (its pnpm is copied to /opt instead).
  assert.match(user, /case "\$dir" in "" \| "\$HOME" \| "\$HOME"\/\*\) ;;/)
  // The only line that runs her command is the sudo -u auma one, with a cleared environment (no GITHUB_ENV, no runtime credential).
  const lines = steps.flatMap(step => scriptOf(step).split('\n')).filter(line => line.includes('$AUMA_COMMAND'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^sudo -u auma env -i PATH="\$AUMA_PATH" HOME=\/home\/auma LANG=C\.UTF-8 CI=true ARTIFACTS=\/home\/auma\/artifacts X61_PLAYWRIGHT_DIR="\$\{X61_PLAYWRIGHT_DIR:-\}" PLAYWRIGHT_BROWSERS_PATH="\$\{PLAYWRIGHT_BROWSERS_PATH:-\}" bash -eo pipefail -c "\$AUMA_COMMAND"$/)
  // Before her user exists, nothing of her branch executes as the runner: no lifecycle script, no pnpmfile hook.
  assert.ok(at('Install dependencies without lifecycle scripts') < at('Make her user (no sudo) and give her the checkout'))
  assert.ok(at('Make her user (no sudo) and give her the checkout') < at('Run her command'))
  // rg comes from the image's own package index, installed by the runner before her user exists (the hosted image has
  // none); the step reads nothing of her checkout and never fails her run for a search tool.
  const ripgrep = scriptOf(steps[at("Install ripgrep (rg) from the image's package index")])
  assert.ok(at("Install ripgrep (rg) from the image's package index") < at('Make her user (no sudo) and give her the checkout'))
  assert.match(ripgrep, /sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends ripgrep/)
  assert.match(ripgrep, /\[ -x \/usr\/bin\/rg \]; then \/usr\/bin\/rg --version; else echo "::warning::ripgrep could not be installed/)
  assert.doesNotMatch(ripgrep, /GITHUB_WORKSPACE|\.\/|pnpm|npm|curl|wget|\bexit\b/)
  // After it, git reads her checkout as auma (her .git/config could name a program), and the runner reads what she left only
  // after her account is locked and every process of hers is stopped, keeping plain files and folders alone.
  const report = scriptOf(steps[at('Report the exit code and what changed')])
  assert.deepEqual(report.split('\n').filter(line => /\bgit\b/.test(line) && !line.includes('.git ]')).map(line => line.trim().split(' git ')[0]),
    Array(2).fill('sudo -u auma env -i PATH=/usr/bin:/bin HOME=/home/auma'))
  const stop = scriptOf(steps[at('Stop her processes and keep only her plain files')])
  const order = ['sudo usermod --lock --expiredate 1 auma', 'sudo pkill -KILL -u auma', 'sudo pkill -KILL -U auma',
    'echo "::error::a process of hers is still running"; exit 1', 'sudo find /home/auma/artifacts -mindepth 1 ! -type f ! -type d -delete',
    'sudo cp -R /home/auma/artifacts/. "$RUNNER_TEMP/artifacts/"']
  const positions = order.map(text => stop.indexOf(text))
  assert.ok(positions.every(position => position >= 0), JSON.stringify(positions))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  assert.match(stop, /^set -euo pipefail\n/)
  // The browser lives under /opt (hers to read, not to write), not in the runner's temp folder.
  assert.match(code, /PW_DIR: \/opt\/x61-playwright\n {10}PLAYWRIGHT_BROWSERS_PATH: \/opt\/x61-playwright\/browsers\n/)
})

test('two body users as powerless as she is; she may run as them and as nobody else; they are stopped before anything is read', () => {
  const steps = stepsOf(code), names = steps.map(nameOf)
  const at = name => { const index = names.indexOf(name); assert.ok(index >= 0, name); return index }
  const made = 'Make two body users for her fixtures (no sudo; she may run as them and as nobody else)'
  // After her user exists, before her command runs.
  assert.ok(at('Make her user (no sudo) and give her the checkout') < at(made))
  assert.ok(at(made) < at('Run her command'))
  const bodies = scriptOf(steps[at(made)])
  assert.match(bodies, /^set -euo pipefail\n/)
  assert.match(bodies, /^for body in body_a body_b; do$/m)
  // Each body: its own group only, checked to have no sudo, a home nobody else enters, and one folder shared with her alone.
  assert.match(bodies, /sudo useradd --create-home --home-dir "\/home\/\$body" --shell \/bin\/bash --user-group "\$body"/)
  assert.match(bodies, /case "\$\(sudo -n -l -U "\$body" 2>&1\)" in \*"may run the following"\*\) echo "::error::\$body may use sudo"; exit 1 ;; esac/)
  assert.match(bodies, /\[ "\$\(id -nG "\$body"\)" = "\$body" \] \|\| \{ echo "::error::\$body is in another group"; exit 1; \}/)
  assert.match(bodies, /sudo chmod 700 "\/home\/\$body"/)
  assert.match(bodies, /sudo chown "\$body:auma" "\/home\/auma\/bodies\/\$body"\n\s*sudo chmod 2770 "\/home\/auma\/bodies\/\$body"/)
  // The ONE sudoers line of the whole workflow: her, as the two bodies, nothing else. Then what it allows is tried.
  const sudoers = code.split('\n').filter(line => line.includes('/etc/sudoers.d/') && line.includes('printf'))
  assert.deepEqual(sudoers.map(line => line.trim()), ["printf 'auma ALL=(body_a,body_b) NOPASSWD: ALL\\n' | sudo tee /etc/sudoers.d/auma-bodies >/dev/null"])
  assert.equal((code.match(/NOPASSWD/g) ?? []).length, 1)
  assert.match(bodies, /sudo visudo -cf \/etc\/sudoers\.d\/auma-bodies/)
  const order = ['sudo -u auma sudo -n -u body_a true', 'sudo -u auma sudo -n -u body_b true',
    'if sudo -u auma sudo -n true 2>/dev/null; then echo "::error::auma may become root"; exit 1; fi',
    'if sudo -u auma sudo -n -u "$(id -un)" true 2>/dev/null; then echo "::error::auma may become the runner"; exit 1; fi',
    'if sudo -u body_a sudo -n -u body_b true 2>/dev/null; then echo "::error::a body may become the other body"; exit 1; fi',
    "if sudo -u body_a test -r /home/auma/bodies/body_b; then echo \"::error::a body can read the other body's folder\"; exit 1; fi"]
  const positions = order.map(text => bodies.indexOf(text))
  assert.ok(positions.every(position => position >= 0), JSON.stringify(positions))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  // No input reaches this step, and nothing of her checkout is read by it.
  assert.doesNotMatch(bodies, /inputs\.|AUMA_COMMAND|\/home\/auma\/repo|pnpm|npm|curl|wget/)
  // At the end the bodies are locked and stopped, and the sudoers line is gone, BEFORE her own stop and before any copy.
  const stop = scriptOf(steps[at('Stop her processes and keep only her plain files')])
  const last = ['for body in body_a body_b; do', 'sudo usermod --lock --expiredate 1 "$body"', 'sudo pkill -KILL -u "$body"',
    'echo "::error::a process of $body is still running"; exit 1', 'sudo rm -f /etc/sudoers.d/auma-bodies',
    'sudo usermod --lock --expiredate 1 auma', 'sudo cp -R /home/auma/artifacts/. "$RUNNER_TEMP/artifacts/"']
  const where = last.map(text => stop.indexOf(text))
  assert.ok(where.every(position => position >= 0), JSON.stringify(where))
  assert.deepEqual([...where].sort((a, b) => a - b), where)
  // Her own command line is unchanged: it still runs as auma, never as a body and never as the runner.
  assert.equal(steps.flatMap(step => scriptOf(step).split('\n')).filter(line => line.includes('$AUMA_COMMAND')).length, 1)
})

test('one run at a time per branch, the run name carries her label, and the job timeout is the validated input', () => {
  assert.match(code, /^run-name: auma-exec \$\{\{ inputs\.label \}\} @ \$\{\{ inputs\.ref \}\}$/m)
  assert.match(code, /^concurrency:\n {2}group: auma-exec-\$\{\{ inputs\.ref \}\}\n {2}cancel-in-progress: false\n {2}queue: max$/m)
  assert.match(code, /^ {4}timeout-minutes: \$\{\{ fromJSON\(inputs\.timeout_minutes\) \}\}$/m)
  const steps = stepsOf(code).map(nameOf)
  assert.equal(steps[0], 'Validate the inputs (fail closed)')
  assert.deepEqual(steps.slice(-3), ['Report the exit code and what changed', 'Stop her processes and keep only her plain files', 'Upload her artifacts'])
  for (const step of stepsOf(code).slice(-3)) assert.match(step, /\n {8}if: always\(\)\n/)
  const upload = stepsOf(code).at(-1)
  assert.match(upload, /name: auma-exec-artifacts\n {10}path: \$\{\{ runner\.temp \}\}\/artifacts\n {10}retention-days: 3\n {10}if-no-files-found: ignore/)
  assert.match(scriptOf(stepsOf(code).at(-3)), /^echo "AUMA_EXIT_CODE=\$\{AUMA_EXIT_CODE:-none\}"\n[^]*git status --short \| head -200\n[^]*git diff --stat \| tail -50/)
  assert.match(code, /if: \$\{\{ inputs\.browser == 'true' \}\}/)
  assert.match(code, /install --with-deps chromium\n/)
  assert.match(code, /run: pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile\n/)
})

/** Runs the workflow's own validation step with these inputs; true when it lets them through. */
const workflowAccepts = inputs => {
  const step = stepsOf(code)[0]
  const result = spawnSync('bash', ['-c', scriptOf(step)], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C',
    AUMA_REF: inputs.ref, AUMA_COMMAND: inputs.command, AUMA_TIMEOUT: inputs.timeout_minutes, AUMA_BROWSER: inputs.browser, AUMA_LABEL: inputs.label } })
  assert.ok(result.status === 0 || result.stdout.includes('::error::AUMA_EXEC_INPUT_INVALID'), result.stderr + result.stdout)
  return result.status === 0
}
const edgeAccepts = inputs => { try { aumaExecInputs(inputs); return true } catch (error) { assert.match(error.code, /^EXEC_[A-Z]+_INVALID$/); return false } }

test('the workflow refuses what the edge refuses, and passes what it passes (the input bounds)', () => {
  const good = { ref: 'auma/proposal/my-fix', command: 'node -v', timeout_minutes: '10', browser: 'false', label: 'x-0123abcd' }
  const cases = [
    [good, true],
    [{ ...good, ref: 'main' }, true], [{ ...good, ref: 'auma/sandbox/a.b_c-1' }, true],
    [{ ...good, ref: 'feature/x' }, false], [{ ...good, ref: 'auma/other/x1' }, false], [{ ...good, ref: 'auma/proposal/ab..cd' }, false],
    [{ ...good, ref: 'auma/proposal/ab.' }, false], [{ ...good, ref: 'auma/proposal/ab.lock' }, false], [{ ...good, ref: 'auma/proposal/Upper' }, false],
    [{ ...good, ref: 'main; rm -rf /' }, false], [{ ...good, ref: '' }, false],
    [{ ...good, command: 'x'.repeat(AUMA_EXEC_LIMITS.commandChars) }, true], [{ ...good, command: 'x'.repeat(AUMA_EXEC_LIMITS.commandChars + 1) }, false],
    [{ ...good, command: '   ' }, false], [{ ...good, command: '' }, false],
    [{ ...good, timeout_minutes: '1' }, true], [{ ...good, timeout_minutes: '30' }, true], [{ ...good, timeout_minutes: '0' }, false],
    [{ ...good, timeout_minutes: '31' }, false], [{ ...good, timeout_minutes: '010' }, false], [{ ...good, timeout_minutes: '5m' }, false],
    [{ ...good, browser: 'true' }, true], [{ ...good, browser: 'yes' }, false],
    [{ ...good, label: 'a'.repeat(64) }, true], [{ ...good, label: 'a'.repeat(65) }, false], [{ ...good, label: 'a b' }, false],
    [{ ...good, label: 'a$(id)' }, false], [{ ...good, label: '' }, false],
  ]
  for (const [inputs, expected] of cases) {
    assert.equal(edgeAccepts(inputs), expected, `edge ${JSON.stringify(inputs).slice(0, 160)}`)
    assert.equal(workflowAccepts(inputs), expected, `workflow ${JSON.stringify(inputs).slice(0, 160)}`)
  }
})
