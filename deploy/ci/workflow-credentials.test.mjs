// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// node --test deploy/ci/workflow-credentials.test.mjs  (reads .github/workflows; no network)
//
// The production Cloudflare credential may reach exactly two places, the deploy job of deploy-x61.yml and
// the manual rollback job of rollback-x61.yml, through the GitHub environment `production` (deployment branch policy:
// main only). The watcher (watch-x61.yml) holds no secret and no write permission, and the observer (observe-x61.yml) no
// secret and no environment. The owner credential (X61_OWNER_JWT) is never a GitHub Actions secret: no workflow names it
// (standing law). A workflow that runs a pull
// request's or a branch's install or build scripts and then hands the credential to a later step in the same job lets
// that code deploy without a passkey (a GITHUB_PATH or GITHUB_ENV plant runs in the later step). So:
//   - no workflow file other than those two names CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID at all;
//   - inside each, only the one credentialed job names them, and only that job declares `environment: production`;
//   - those jobs install and build nothing, and every step that receives a credential value runs only the pinned
//     Wrangler and shell, never repository code;
//   - every action on the deploy path is pinned by full commit SHA.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../../.github/workflows/', import.meta.url))
const NAMES = /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/
/** Whether a workflow declares the environment `production` itself (bare, quoted, as `name:`, or as an expression's
 * result; a comparison like `preset == 'production'` and other names like desktop-production do not count). */
const declaresProduction = source => {
  const lines = source.split('\n')
  return lines.some((line, index) => {
    if (!/^\s*environment:/.test(line)) return false
    const value = (/^\s*environment:\s*$/.test(line) ? lines[index + 1] ?? '' : line).replace(/==\s*'production'/g, '')
    return /(?<![-\w])production(?![-\w])/.test(value)
  })
}
const files = readdirSync(DIR).filter(name => /\.ya?ml$/.test(name)).sort()
const text = name => readFileSync(join(DIR, name), 'utf8')

/** Top-level job bodies, keyed by job id. */
export const jobsOf = source => Object.fromEntries(source.split('\njobs:\n')[1].split(/\n(?=  [a-z][a-z0-9-]*:\n)/).map(block => {
  const [first, ...rest] = block.replace(/^\n+/, '').split('\n')
  return [first.trim().replace(/:$/, ''), rest.join('\n')]
}).filter(([name]) => /^[a-z][a-z0-9-]*$/.test(name)))
/** Step bodies of a job (each begins at its `- ` line). */
const stepsOf = job => job.split(/\n(?= {6}- )/).slice(1)
/** A step that receives a credential VALUE (a presence test `secrets.X != ''` hands over only true or false). */
const receivesCredential = step => /secrets\.(?:CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*\}\}/.test(step)
const scriptOf = step => {
  const block = step.split(/\n {8}run: \|\n/)[1]
  if (block !== undefined) return block.split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n')
  return step.match(/\n {8}run: (.+)/)?.[1] ?? ''
}
const REPOSITORY_CODE = [/\bnode\b/, /\bpnpm\b/, /\bnpm\b/, /\byarn\b/, /\bbash\b/, /(?:^|[\s;&|(])sh\s/, /\bsource\b/, /(?:^|[\s;&|(])\.\s/, /\bmake\b/,
  /(?:^|[\s;&|("'])\.{0,2}\/?(?:deploy|server|scripts|packages|apps|mirror|tools)\/\S+\.(?:m?js|ts|sh|py)\b/, /(?:^|[\s;&|(])\.\/\S/]

/** The only workflows, and in each the only job, that may hold the production credential. */
const CREDENTIALED = Object.freeze({ 'deploy-x61.yml': 'deploy', 'rollback-x61.yml': 'rollback' })

test('no workflow except deploy-x61.yml and rollback-x61.yml names the production Cloudflare credential or declares the environment', () => {
  assert.ok(files.includes('deploy-x61.yml') && files.includes('rollback-x61.yml') && files.includes('watch-x61.yml') && files.includes('observe-x61.yml') && files.length > 5)
  assert.doesNotMatch(text('watch-x61.yml'), /secrets\./)
  assert.doesNotMatch(text('observe-x61.yml'), /^\s*environment:/m)
  for (const name of files) {
    if (Object.hasOwn(CREDENTIALED, name)) continue
    assert.doesNotMatch(text(name), NAMES, `${name} names the production Cloudflare credential`)
    assert.equal(declaresProduction(text(name)), false, `${name} declares the production environment`)
  }
})

for (const [file, credentialed] of Object.entries(CREDENTIALED)) test(`inside ${file} only the ${credentialed} job names the credential and only it declares environment production`, () => {
  const jobs = jobsOf(text(file))
  assert.ok(jobs[credentialed], `${credentialed} job`)
  for (const [id, body] of Object.entries(jobs)) {
    if (id === credentialed) continue
    assert.doesNotMatch(body, NAMES, `job ${id} names the credential`)
    assert.equal(declaresProduction(body), false, `job ${id} declares the production environment`)
  }
  assert.match(jobs[credentialed], /^ {4}environment: production$/m)
  assert.equal(declaresProduction(jobs[credentialed]), true)
  assert.equal(declaresProduction('    environment:\n      name: production\n'), true)
  assert.equal(declaresProduction("    environment: ${{ x == 'production' && 'desktop-production' || 'desktop-test' }}\n"), false)
  assert.equal([...jobs[credentialed].matchAll(/^\s*environment:/gm)].length, 1)
  assert.match(jobs[credentialed], /^ {4}if: github\.ref == 'refs\/heads\/main'$/m)
  // No job-level env: a credential is scoped to the steps that need it.
  assert.doesNotMatch(jobs[credentialed].split('\n    steps:\n')[0], /^ {4}env:/m)
  assert.doesNotMatch(text(file).split('\njobs:\n')[0], NAMES)
})

test('no file under .github/workflows names the owner credential X61_OWNER_JWT (standing law: it is never a GitHub Actions secret)', () => {
  const all = readdirSync(DIR, { recursive: true }).map(String).filter(name => !name.split('/').some(part => part === '..'))
  assert.ok(all.length > 5)
  for (const name of all) {
    let body
    try { body = readFileSync(join(DIR, name), 'utf8') } catch (error) { if (error?.code === 'EISDIR') continue; throw error }
    assert.doesNotMatch(body, /X61_OWNER_JWT/i, name)
    assert.doesNotMatch(body, /OWNER_JWT/i, name)
  }
  assert.doesNotMatch(text('observe-x61.yml'), /secrets\./)
})

test('the watcher (watch-x61.yml) can write nothing: contents: read is its only permission, and it is not started by other runs', () => {
  const watch = text('watch-x61.yml')
  assert.deepEqual([...watch.matchAll(/^\s*permissions:\s*\n((?:\s{2,}\S[^\n]*\n)+)/gm)].map(match => match[1].trim().split(/\n\s*/)), [['contents: read']])
  assert.doesNotMatch(watch, /:\s*write\b|write-all|workflow_run|\bgh (?:workflow|run)\b/)
})

const CREDENTIALED_STEPS = Object.freeze({
  'deploy-x61.yml': ['Read the live Worker deployment before deploying', 'Deploy the scrubbed Worker bundle to Cloudflare'],
  'rollback-x61.yml': ['Roll back the Worker'],
})
for (const [file, job] of Object.entries(CREDENTIALED)) test(`the ${job} job of ${file} installs and builds nothing, and a credentialed step runs only the pinned Wrangler and shell`, () => {
  const deploy = jobsOf(text(file))[job]
  assert.doesNotMatch(deploy, /pnpm|npm (?:ci|install|run)|yarn|build-preview|tsdown|--filter|cache@|actions\/cache/)
  for (const uses of deploy.match(/uses: \S+/g)) assert.match(uses, /^uses: actions\/(?:checkout|setup-node|download-artifact)@[0-9a-f]{40}$/)
  const credentialed = stepsOf(deploy).filter(receivesCredential)
  assert.deepEqual(credentialed.map(step => step.match(/- name: (.+)/)[1]), CREDENTIALED_STEPS[file])
  for (const step of credentialed) {
    const name = step.match(/- name: (.+)/)[1]
    assert.doesNotMatch(step, /\n {8}uses:/, name)
    const script = scriptOf(step)
    assert.ok(script.includes('npx --yes wrangler@4.155.0 '), name)
    for (const line of script.split('\n')) {
      const npx = [...line.matchAll(/\bnpx\b(.{0,30})/g)]
      for (const match of npx) assert.match(match[1], /^ --yes wrangler@4\.155\.0 /, `${name}: ${line}`)
      const withoutWrangler = line.replace(/npx --yes wrangler@4\.155\.0 [^|;&]*/g, 'WRANGLER')
      for (const pattern of REPOSITORY_CODE) assert.doesNotMatch(withoutWrangler, pattern, `${name} runs repository code: ${line}`)
    }
  }
  // Steps that run repository code (deploy/ci) never hold a credential value.
  for (const step of stepsOf(deploy).filter(step => /deploy\/ci\//.test(scriptOf(step)))) assert.equal(receivesCredential(step), false, step.slice(0, 80))
  if (file !== 'deploy-x61.yml') return
  // The presence check hands over only true or false.
  const presence = stepsOf(deploy).find(step => step.includes('- name: Require Cloudflare credentials'))
  assert.match(presence, /HAS_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN != '' \}\}/)
  assert.match(presence, /HAS_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID != '' \}\}/)
})

test('every action on the deploy, rollback, watch and observe paths and in the proposal gate is pinned by full commit SHA', () => {
  // The two small workflows use two actions each; the observer five (its two jobs); the deploy and the proposal gate keep
  // their original floor.
  const floor = { 'deploy-x61.yml': 6, 'proposal-gate.yml': 6, 'rollback-x61.yml': 2, 'watch-x61.yml': 2, 'observe-x61.yml': 5 }
  for (const [name, least] of Object.entries(floor)) {
    const uses = text(name).match(/uses: \S+/g)
    assert.ok(uses.length >= least, name)
    for (const item of uses) assert.match(item, /^uses: [a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/, `${name}: ${item}`)
  }
})

test('the guard catches the inherited pattern: install and build, then the credential in the same job', () => {
  // The shape build-preview-cloudflare.yml had before this commit, checked with the same rules.
  const inherited = `name: inherited\njobs:\n  preview:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Install (immutable)\n        run: pnpm install --frozen-lockfile\n\n      - name: Upload to Cloudflare Pages\n        env:\n          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}\n        run: |\n          npx --yes wrangler@4 pages deploy apps/web/dist\n`
  const [step] = stepsOf(jobsOf(inherited).preview).filter(receivesCredential)
  assert.ok(step && NAMES.test(inherited))
  assert.doesNotMatch(scriptOf(step), /npx --yes wrangler@4\.155\.0 /)
  assert.match(jobsOf(inherited).preview, /pnpm install/)
})

/** The only workflows that may hold `actions: write` (which can dispatch, re-run or cancel x61 workflows). */
const ACTIONS_WRITERS = Object.freeze(['deploy-x61.yml', 'rollback-x61.yml'])
/** Whether a workflow grants `actions: write` anywhere: a block or flow mapping, quoted or not, or write-all. */
const grantsActionsWrite = source => /(?:^|[\s{,])["']?actions["']?\s*:\s*["']?write\b/m.test(source.replace(/#[^\n]*/g, '')) || /\bwrite-all\b/.test(source.replace(/#[^\n]*/g, ''))

test('no workflow except deploy-x61.yml and rollback-x61.yml may hold actions: write, and every workflow sets its own permissions', () => {
  assert.equal(grantsActionsWrite('jobs:\n  a:\n    permissions:\n      actions: write\n'), true)
  assert.equal(grantsActionsWrite('jobs:\n  a:\n    permissions: { contents: read, actions: write }\n'), true)
  assert.equal(grantsActionsWrite("permissions:\n  'actions': 'write'\n"), true)
  assert.equal(grantsActionsWrite('permissions: write-all\n'), true)
  assert.equal(grantsActionsWrite('permissions:\n  actions: read\n# actions: write is not here\n'), false)
  assert.ok(files.length > 5)
  for (const name of files) {
    // A workflow with no top-level permissions holds whatever the repository default is, which may be write.
    assert.match(text(name), /^permissions:/m, `${name} sets no top-level permissions`)
    if (ACTIONS_WRITERS.includes(name)) continue
    assert.equal(grantsActionsWrite(text(name)), false, `${name} holds actions: write`)
  }
})

test('the inherited Policy recheck (pr-check-on-base-branch.yml) is inert: started only by hand, no permission, no action', () => {
  const policy = text('pr-check-on-base-branch.yml')
  const header = policy.split('\njobs:\n')[0].replace(/^#[^\n]*\n/gm, '')
  assert.match(header, /^on:\n {2}workflow_dispatch:\npermissions: \{\}\n/m)
  assert.doesNotMatch(header, /push:|pull_request|schedule:|workflow_run:|workflow_call:|repository_dispatch:/)
  const jobs = jobsOf(policy)
  assert.deepEqual(Object.keys(jobs), ['recheck'])
  assert.match(jobs.recheck, /^ {4}permissions: \{\}$/m)
  assert.doesNotMatch(jobs.recheck, /uses:|secrets\.|vars\.|^ {4}if:/m)
  assert.match(jobs.recheck, /switched off in this repository and checked nothing\."\n {10}exit 1\n?$/)
})
