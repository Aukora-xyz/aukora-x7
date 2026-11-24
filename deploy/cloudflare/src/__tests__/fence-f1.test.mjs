// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * FENCE F1: the two rules that make a lock card different from a product card, pinned where they live.
 *
 * Why this file is HERE and not under deploy/ci: `proposal-gate.yml`'s target job restores main's `deploy/ci`
 * by removing the directory and checking main's copy out over it. A file this branch ADDS under deploy/ci is
 * therefore still listed in git but absent from the disk, and main's own `frozen-paths.test.mjs` walks `deploy/`
 * from git and reads every path it lists — it died with ENOENT on this file at :508 and :587 (gate run
 * 44880961897). So F1's pins live under deploy/cloudflare instead, where nothing removes them.
 *
 * Rule A — the gate is MAIN's gate. `proposal-gate.yml`'s `target` job checks the proposal out, then puts main's
 * `deploy/ci` and the two server modules the gate scripts import back over the tree, runs the gates there, and only
 * then publishes `sha`. A red gate leaves `sha` unset, so every downstream gate job is skipped, and the edge reads the
 * run as failed. The twin is the run line that would let the proposal's own gate judge it.
 *
 * Rule B — a lock diff waits for BOTH workflows, and that rule lives in the broker, not in the fence. Main's own
 * frozen-paths.test.mjs requires the level step to read `open` even when the diff touches `.github/workflows/**` and
 * `deploy/ci/**` (its open-door fixture changes exactly those two), and main's copy is the copy the gate runs, so the
 * fence cannot be made lock-aware from a proposal branch at all. `cloud-brokers.mjs` reads both workflows at its two
 * stage sites and its merge. The twin is a stage site left as the bare `proposalCi(...)` call, which would quietly go
 * back to the fast gate alone.
 *
 * These are source pins, not a substitute for running the code: they fail when the text that carries the rule is
 * removed or bypassed, which is exactly the mistake they exist to stop.
 * node --test deploy/cloudflare/src/__tests__/fence-f1.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const read = path => readFileSync(join(ROOT, path), 'utf8')

/** One job's text, from its two-space key to the next job at the same indent. */
const jobText = (yaml, name) => {
  const start = yaml.indexOf(`\n  ${name}:\n`)
  if (start < 0) return ''
  const rest = yaml.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/u)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

/** Every `run:` script in a job, in order. */
const runScripts = job => {
  const out = []
  const lines = job.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^ {6,}-?\s*run:/u.test(line) && !/^\s+run:\s*\|?\s*$/u.test(line)) continue
    const inline = line.replace(/^\s*-?\s*run:\s*/u, '').trim()
    if (inline && inline !== '|' && inline !== '>') { out.push(inline); continue }
    const body = []
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === '' || /^\s{8,}\S/u.test(lines[j])) { body.push(lines[j].trim()); continue }
      break
    }
    out.push(body.join('\n'))
  }
  return out
}

test('F1 rule A: the gate target puts main\'s gate scripts back and runs them before publishing sha', () => {
  const gate = read('.github/workflows/proposal-gate.yml')
  const target = jobText(gate, 'target')
  assert.ok(target.length > 0, 'target job not found')
  const scripts = runScripts(target)
  const restore = scripts.find(script => script.includes("git checkout 'refs/remotes/origin/main'"))
  assert.ok(restore !== undefined, 'no step restores main\'s copies from origin/main')
  for (const path of ['deploy/ci', 'server/ball-transition.mjs', 'server/ball-manifest.mjs']) {
    assert.ok(restore.includes(path), `restore step does not cover ${path}`)
  }
  const gateRun = scripts.find(script => script.includes('node --test deploy/ci/*.test.mjs'))
  assert.ok(gateRun !== undefined, 'no step runs main\'s gate tests')
  for (const command of ['node deploy/ci/scrub-gate.mjs --source', 'node deploy/ci/deploy-guard.mjs verify-mirror',
    'node deploy/ci/authority-preflight.mjs']) {
    assert.ok(gateRun.includes(command), `gate step does not run ${command}`)
  }
  // The sha is published LAST: if the gate above it fails, no gate job can read a sha and all of them skip.
  const echo = scripts.findIndex(script => script.includes('sha=$GITHUB_SHA'))
  assert.ok(echo > scripts.indexOf(gateRun), 'sha is published before the gate runs')
  // Twin: a single-line gate that merely installs and stops would satisfy "a run exists" and protect nothing.
  assert.ok(!/pnpm install --frozen-lockfile --ignore-scripts\n(\s*\n)?$|^pnpm install --frozen-lockfile --ignore-scripts$/u.test(gateRun.replace(/[\s\S]*node --test/u, 'node --test')),
    'the gate step is the install alone')
})

test('F1 rule B (broker): both stage sites pass the lock fact, and no site is left with the bare call', () => {
  const broker = read('deploy/cloudflare/src/cloud-brokers.mjs')
  const withLock = broker.match(/proposalCi\([^)]*\{ lock: touchesLock\(evidence\.changedFiles\) \}/gu) ?? []
  assert.equal(withLock.length, 2, 'stage_proposal and the wake stage act must both pass the lock fact')
  // The merge reads the fact from mergeEvidence and passes the same flag.
  assert.match(broker, /const \{ before, after, lock \} = await mergeEvidence\(input, env, context\)/u,
    'mergeEvidence does not report the lock fact')
  assert.match(broker, /proposalCi\(input\.branch, input\.headSha, env, context, \{ concurrent: true, lock \}\)/u,
    'the merge does not pass the lock fact')
  assert.match(broker, /repoDoorLevel\(context\) === 'open' && !lock \? \{ next: PROPOSAL_GATE_CI_NEXT \}/u,
    'a lock refusal must not offer the gate-only next step')
  // Twin: a bare stage call is exactly the regression that would restore the fast-gate-only card.
  const bare = broker.match(/ciStatus: await proposalCi\((?:input|shaped)\.branch, evidence\.headSha, env, context\)/gu) ?? []
  assert.deepEqual(bare, [], 'a stage site still calls proposalCi without the lock fact')
})

test('F1 plumbing: touchesLock asks main\'s own export for the guarded judgement, and no invented name is imported', () => {
  // The gate replaces deploy/ci with main's copy, so product code may import only names main already exports. The lock is
  // isFrozenRepoPath(path, 'guarded') — no new export on the fence side, nothing main must carry first.
  const broker = read('deploy/cloudflare/src/cloud-brokers.mjs')
  assert.match(broker, /export const touchesLock = files => Array\.isArray\(files\) && files\.some\(file => isFrozenRepoPath\(file\?\.path, 'guarded'\)\)/u,
    'touchesLock must ask main\'s isFrozenRepoPath for the guarded judgement')
  assert.match(broker, /from '\.\.\/\.\.\/ci\/frozen-paths\.mjs'/u, 'the broker still imports the fence it is judged with')
  // Twin: a name the fence only exists on this branch is exactly what broke the gate (two suites died at load, 44880961897).
  assert.ok(!broker.includes('isLockRepoPath'), 'the broker imports a name main\'s deploy/ci does not export')
  // Twin: a second, hand-rolled judgement would drift from the fence main judges with.
  const handRolled = broker.match(/file\?\.path[^\n]*startsWith\('\.github'\)|startsWith\('deploy\/ci'\)/gu) ?? []
  assert.deepEqual(handRolled, [], 'cloud-brokers re-implements the lock paths instead of asking the fence')
})
